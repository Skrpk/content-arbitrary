import { z } from 'zod';
import type {
  HistoricalMediaItem,
  HistoricalPublicationItem,
  HistoryFile,
  HistoryImportIssue,
  ParsedPublicationHistory,
  PublicationHistoryAdapter,
} from '@/lib/history/types';

/**
 * Telegram Desktop's machine-readable export of one chat ("Export chat
 * history" → JSON), i.e. its `result.json`.
 *
 * Field names follow the exporter's source, Telegram/SourceFiles/export/output/
 * export_output_json.cpp in telegramdesktop/tdesktop (read 2026-10-06). What it
 * writes, and what that means here:
 *   - top level: `name`, `type` (`public_channel`, `private_channel`, …), `id`
 *     (the bare peer id) and `messages`;
 *   - `date` is the exporting computer's local time with no zone, so
 *     `date_unixtime` (seconds, as a string) is the one relied on;
 *   - a file that was not downloaded is written as a sentence in brackets,
 *     e.g. "(File not included. Change data exporting settings to download.)",
 *     in place of its path;
 *   - no channel username, no view or forward counts, and no album id: each
 *     photo of an album is its own message. So no canonical URL is built,
 *     metrics hold reactions only, and albums stay one item per message;
 *   - a post in Telegram's article format comes as `rich_message` — a tree of
 *     blocks (headings, paragraphs, photos, lists, …) — instead of `text`.
 *
 * Reads the whole file into memory; see README for the practical size limit.
 */
export const telegramJsonAdapter: PublicationHistoryAdapter = {
  type: 'telegram-json',
  parse: async (file) => parseTelegramExport(decodeJson(file)),
};

export const TELEGRAM_PLATFORM = 'telegram';

/** A Telegram chat export file that is not one at all: wrong file, bad JSON. */
export class HistoryFormatError extends Error {
  override readonly name = 'HistoryFormatError';
}

const exportSchema = z.object({
  name: z.string().nullable().optional(),
  type: z.string().optional(),
  id: z.union([z.number(), z.string()]).optional(),
  messages: z.array(z.unknown()),
});

/** Chat types whose Bot API id is the bare id behind a `-100` prefix. */
const CHANNEL_TYPES = new Set([
  'public_channel',
  'private_channel',
  'public_supergroup',
  'private_supergroup',
]);

const PLACEHOLDER = /\((?:File|Photo)[^)]*(?:not included|exceeds maximum size|unavailable)/i;

function decodeJson(file: HistoryFile): unknown {
  const text = new TextDecoder().decode(file.bytes).replace(/^﻿/, '');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new HistoryFormatError(`${file.name} is not valid JSON: ${(error as Error).message}`);
  }
}

export function parseTelegramExport(raw: unknown): ParsedPublicationHistory {
  if (isRecord(raw) && !('messages' in raw) && 'chats' in raw) {
    throw new HistoryFormatError(
      'This is a whole-account export. Export the channel on its own: open it in Telegram Desktop → ⋮ → Export chat history → JSON.',
    );
  }
  const parsed = exportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HistoryFormatError(
      `Not a Telegram Desktop chat export (expected "messages" at the top level): ${parsed.error.issues[0]?.message ?? ''}`,
    );
  }
  const chat = parsed.data;

  const items: HistoricalPublicationItem[] = [];
  const skipped: HistoryImportIssue[] = [];
  const failed: HistoryImportIssue[] = [];
  const warnings: HistoryImportIssue[] = [];

  for (const message of chat.messages) {
    const result = toItem(message);
    if ('item' in result) {
      items.push(result.item);
      if (result.warning) warnings.push({ externalId: result.item.externalId, reason: result.warning });
    } else if (result.kind === 'skipped') skipped.push(result.issue);
    else failed.push(result.issue);
  }

  return {
    platform: TELEGRAM_PLATFORM,
    publicationKey: publicationKeyOf(chat),
    publicationName: chat.name ?? null,
    publicationMetadata: {
      ...(chat.name ? { name: chat.name } : {}),
      ...(chat.type ? { chatType: chat.type } : {}),
      ...(chat.id !== undefined ? { exportId: String(chat.id) } : {}),
    },
    itemsSeen: chat.messages.length,
    items,
    skipped,
    failed,
    warnings,
  };
}

/**
 * The chat's id, in the form the Bot API — and `workspaces.telegram_chat_id` —
 * use, so history can later be matched to the channel the bot posts to. Without
 * an id, the name stands in; a renamed channel then gets a new key.
 */
function publicationKeyOf(chat: z.infer<typeof exportSchema>): string {
  const id = chat.id === undefined ? '' : String(chat.id).trim();
  if (/^\d+$/.test(id)) {
    if (chat.type && CHANNEL_TYPES.has(chat.type)) return `-100${id}`;
    if (chat.type === 'private_group') return `-${id}`;
    return id;
  }
  const name = chat.name?.trim().toLowerCase().replace(/\s+/g, ' ');
  if (name) return `name:${name}`;
  throw new HistoryFormatError('The export has neither a chat id nor a chat name to identify it by');
}

type ItemResult =
  | { item: HistoricalPublicationItem; warning?: string }
  | { kind: 'skipped' | 'failed'; issue: HistoryImportIssue };

function toItem(raw: unknown): ItemResult {
  if (!isRecord(raw)) return fail(null, 'not_an_object');

  const id = typeof raw.id === 'number' || typeof raw.id === 'string' ? String(raw.id) : '';
  if (!/^-?\d+$/.test(id)) return fail(null, 'missing_id');

  if (raw.type === 'service') return skip(id, `service:${stringOf(raw.action) ?? 'unknown'}`);
  if (raw.type !== 'message') return skip(id, `type:${stringOf(raw.type) ?? 'missing'}`);

  const published = dateOf(raw.date_unixtime, raw.date);
  if (!published) return fail(id, 'invalid_date');

  const rich = isRecord(raw.rich_message) ? richMessage(raw.rich_message) : null;
  const plain = plainText(raw.text);
  const text = rich ? rich.text : plain.text;
  const links = [...plain.links, ...(rich?.links ?? [])];
  const media = [...mediaOf(raw), ...(rich?.media ?? [])];

  // Only an item with neither words nor media is nothing to remember. A photo
  // or video with no caption is still something the channel published.
  if (!text && media.length === 0) {
    const what = raw.poll ? 'poll' : rich ? 'rich_message' : raw.location_information ? 'location' : 'empty';
    return skip(id, `no_text_or_media:${what}`);
  }

  return {
    item: {
      externalId: id,
      contentType: 'post',
      title: null,
      text,
      publishedAt: published.date,
      editedAt: dateOf(raw.edited_unixtime, raw.edited)?.date ?? null,
      canonicalUrl: null,
      media,
      metrics: metricsOf(raw.reactions),
      metadata: compact({
        from: stringOf(raw.from),
        fromId: stringOf(raw.from_id),
        author: stringOf(raw.author),
        forwardedFrom: stringOf(raw.forwarded_from),
        forwardedFromId: stringOf(raw.forwarded_from_id),
        savedFrom: stringOf(raw.saved_from),
        replyToMessageId: numberOf(raw.reply_to_message_id),
        viaBot: stringOf(raw.via_bot),
        links: links.length > 0 ? links : undefined,
        format: rich ? 'rich_message' : undefined,
      }),
    },
    warning: published.zoneless ? 'date_without_timezone_read_as_utc' : undefined,
  };
}

/**
 * The text a reader sees, formatting dropped. `text` is either a string or an
 * array of strings and `{ type, text }` parts; joining the parts' `text` gives
 * back the visible text, URLs and @mentions included. A hidden link's target
 * (`text_link`) is not in the visible text, so it is returned separately.
 * `text_entities` repeats the same content and is not read.
 */
export function plainText(value: unknown): { text: string | null; links: string[] } {
  const links: string[] = [];
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else if (Array.isArray(value)) {
    for (const part of value) {
      if (typeof part === 'string') {
        text += part;
      } else if (isRecord(part)) {
        if (typeof part.text === 'string') text += part.text;
        if (part.type === 'text_link' && typeof part.href === 'string') links.push(part.href);
      }
    }
  }
  const normalised = text.replace(/\r\n?/g, '\n').trim();
  return { text: normalised === '' ? null : normalised, links };
}

/**
 * The text and media of an article-format post. Blocks are walked generically
 * — any `text`, `title` or caption is text, any `blocks`, `block`, `items` or
 * `rows` is more blocks — so a block kind not known here still gives up its
 * text instead of failing the post. Blocks are separated by a blank line.
 */
export function richMessage(rich: Record<string, unknown>): {
  text: string | null;
  links: string[];
  media: HistoricalMediaItem[];
} {
  const paragraphs: string[] = [];
  const links: string[] = [];
  const media: HistoricalMediaItem[] = [];

  const visit = (block: unknown): void => {
    if (Array.isArray(block)) return block.forEach(visit);
    if (!isRecord(block)) return;

    const item = richMediaOf(block);
    if (item) media.push(item);

    const caption = isRecord(block.caption) ? block.caption.text : undefined;
    for (const node of [block.title, block.text, caption]) {
      const text = richText(node, links).trim();
      if (text) paragraphs.push(text);
    }
    for (const key of ['blocks', 'block', 'items', 'rows', 'cells']) visit(block[key]);
  };
  visit(rich.blocks);

  const text = paragraphs.join('\n\n').replace(/\r\n?/g, '\n').trim();
  return { text: text === '' ? null : text, links, media };
}

/** A rich-text node is `{ type, text }`, its `text` a string, a node or a list of them. */
function richText(node: unknown, links: string[]): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map((child) => richText(child, links)).join('');
  if (!isRecord(node)) return '';
  if (node.type === 'text_link' && typeof node.href === 'string') links.push(node.href);
  if (node.type === 'math' && typeof node.source === 'string') return node.source;
  return richText(node.text, links);
}

/** A photo, video, audio or file block; unavailable when the export skipped it. */
function richMediaOf(block: Record<string, unknown>): HistoricalMediaItem | null {
  if (block.type === 'photo' && ('photo' in block || 'photo_skip_reason' in block)) {
    return {
      type: 'photo',
      ...richPathOf(block.photo),
      width: numberOf(block.width) ?? null,
      height: numberOf(block.height) ?? null,
      fileSizeBytes: numberOf(block.photo_file_size) ?? null,
    };
  }
  if (['video', 'audio', 'file'].includes(block.type as string) && ('file' in block || 'file_skip_reason' in block)) {
    const fallback = block.type === 'video' ? 'video' : block.type === 'audio' ? 'audio' : 'document';
    return {
      type: block.media_type === undefined ? fallback : fileType(block.media_type),
      ...richPathOf(block.file),
      mimeType: stringOf(block.mime_type) ?? null,
      width: numberOf(block.width) ?? null,
      height: numberOf(block.height) ?? null,
      durationSeconds: numberOf(block.duration_seconds) ?? null,
      fileSizeBytes: numberOf(block.file_size) ?? null,
    };
  }
  return null;
}

/** In a rich block a skipped file has no path at all, only a `*_skip_reason`. */
function richPathOf(value: unknown): { relativePath: string | null; available: boolean } {
  return typeof value === 'string' ? pathOf(value) : { relativePath: null, available: false };
}

/** `unixtime` first; the local-time `date` only as a fallback, read as UTC. */
function dateOf(unixtime: unknown, local: unknown): { date: Date; zoneless: boolean } | null {
  const seconds = typeof unixtime === 'string' || typeof unixtime === 'number' ? Number(unixtime) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) return { date: new Date(seconds * 1000), zoneless: false };

  if (typeof local === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(local)) {
    const date = new Date(`${local}Z`);
    if (!Number.isNaN(date.getTime())) return { date, zoneless: true };
  }
  return null;
}

function mediaOf(raw: Record<string, unknown>): HistoricalMediaItem[] {
  const media: HistoricalMediaItem[] = [];

  if (typeof raw.photo === 'string') {
    media.push({
      type: 'photo',
      ...pathOf(raw.photo),
      width: numberOf(raw.width) ?? null,
      height: numberOf(raw.height) ?? null,
      fileSizeBytes: numberOf(raw.photo_file_size) ?? null,
    });
  }

  if (typeof raw.file === 'string') {
    media.push({
      type: fileType(raw.media_type),
      ...pathOf(raw.file),
      mimeType: stringOf(raw.mime_type) ?? null,
      width: numberOf(raw.width) ?? null,
      height: numberOf(raw.height) ?? null,
      durationSeconds: numberOf(raw.duration_seconds) ?? null,
      fileSizeBytes: numberOf(raw.file_size) ?? null,
    });
  }

  return media;
}

function fileType(mediaType: unknown): HistoricalMediaItem['type'] {
  switch (mediaType) {
    case 'video_file':
    case 'video_message':
      return 'video';
    case 'animation':
      return 'animation';
    case 'audio_file':
    case 'voice_message':
      return 'audio';
    case 'sticker':
      return 'sticker';
    case undefined:
      // A file with no media type is an ordinary attachment.
      return 'document';
    default:
      return 'other';
  }
}

/** A placeholder sentence is not a path: the file is simply not in the export. */
function pathOf(value: string): { relativePath: string | null; available: boolean } {
  const trimmed = value.trim();
  if (trimmed === '' || PLACEHOLDER.test(trimmed) || /^\(.*\)$/s.test(trimmed)) {
    return { relativePath: null, available: false };
  }
  return { relativePath: trimmed, available: true };
}

/**
 * Reactions, by kind and count. Who reacted (`recent`) is left behind: it is
 * personal data and says nothing about the post.
 */
function metricsOf(reactions: unknown): Record<string, unknown> | null {
  if (!Array.isArray(reactions)) return null;
  let total = 0;
  const counted = reactions.filter(isRecord).flatMap((reaction) => {
    const count = numberOf(reaction.count);
    if (count === undefined) return [];
    total += count;
    return [
      compact({
        type: stringOf(reaction.type),
        emoji: stringOf(reaction.emoji),
        documentId: stringOf(reaction.document_id),
        count,
      }),
    ];
  });
  if (counted.length === 0) return null;
  return { reactions: counted, reactionsTotal: total };
}

function skip(externalId: string | null, reason: string): ItemResult {
  return { kind: 'skipped', issue: { externalId, reason } };
}

function fail(externalId: string | null, reason: string): ItemResult {
  return { kind: 'failed', issue: { externalId, reason } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function numberOf(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

/** Drop the absent fields; null if nothing is left. */
function compact(values: Record<string, unknown>): Record<string, unknown> | null {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}
