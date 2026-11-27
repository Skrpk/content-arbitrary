import { createHash } from 'node:crypto';
import { ChannelPageError } from '@/lib/errors';
import type {
  HistoricalMediaItem,
  HistoricalPublicationItem,
  HistoryImportIssue,
  ParsedPublicationHistory,
} from '@/lib/history/types';
import { TELEGRAM_PLATFORM } from '@/lib/history/adapters/telegram-json';
import {
  HISTORY_MAX_MESSAGES_SCANNED,
  HISTORY_MAX_WAIT_MS,
  HISTORY_PAGE_DELAY_MS,
  HISTORY_TARGET_USABLE_POSTS,
} from '@/lib/onboarding/limits';
import { fetchChannelPage, type FetchChannelOptions } from '@/lib/telegram-channel/client';
import type { ChannelPage, ChannelPagePost } from '@/lib/telegram-channel/parser';

/**
 * A public channel's own recent posts, read from its web page (t.me/s/<name>)
 * a page at a time, newest first — what onboarding learns the channel from,
 * without the owner exporting anything.
 *
 * Only the latest HISTORY_TARGET_USABLE_POSTS usable posts are kept, looking
 * at no more than HISTORY_MAX_MESSAGES_SCANNED messages: a recent picture of
 * the channel, read in a few seconds. The result is a ParsedPublicationHistory,
 * stored like an export (storeParsedPublicationHistory) under the same key a
 * Telegram Desktop export of the channel would have, so a later export
 * updates these items rather than duplicating them.
 *
 * The page's media links expire, so media are recorded as metadata only.
 */

export const TELEGRAM_PUBLIC_ADAPTER = 'telegram-public';

export interface CrawlOptions extends FetchChannelOptions {
  /** Waits between pages and out short rate limits; injected by tests. */
  sleep?: (ms: number) => Promise<void>;
  targetUsable?: number;
  maxScanned?: number;
}

export interface CrawledHistory {
  /** The channel's title, as its page shows it. */
  title: string | null;
  parsed: ParsedPublicationHistory;
  /** Messages looked at, and the usable posts kept among them. */
  inspected: number;
  usable: number;
  /** The page ran out before the target: the channel has no more posts. */
  exhausted: boolean;
  /** SHA-256 of the items kept, as canonical JSON: the audit record's fingerprint. */
  sha256: string;
}

/**
 * Read the channel's latest posts. `publicationKey` is the channel's Bot API
 * id (`-100…`), as `workspaces.telegram_chat_id` and the Desktop export use;
 * `tg:<username>` when it cannot be known.
 *
 * Throws ChannelPageError as the page does — a channel with no public page,
 * or, transient, t.me not answering or rate limiting for longer than
 * HISTORY_MAX_WAIT_MS — for the caller to report or retry; a retry reads
 * from the start, and storing it again changes nothing.
 */
export async function crawlChannelHistory(
  username: string,
  input: { publicationKey: string } & CrawlOptions,
): Promise<CrawledHistory> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const targetUsable = input.targetUsable ?? HISTORY_TARGET_USABLE_POSTS;
  const maxScanned = input.maxScanned ?? HISTORY_MAX_MESSAGES_SCANNED;

  const seen = new Map<number, ChannelPagePost>();
  let title: string | null = null;
  let before: number | undefined;
  let exhausted = false;
  let usable = 0;

  for (let pageIndex = 0; ; pageIndex += 1) {
    if (pageIndex > 0) await sleep(HISTORY_PAGE_DELAY_MS);
    const page = await fetchPatiently(username, { ...input, before }, sleep);
    if (pageIndex === 0) title = page.title;

    // A page holds the ~20 posts before `before`, oldest first. Only ever older ones count.
    const fresh = page.posts.filter((post) => (before === undefined || post.messageId < before) && !seen.has(post.messageId));
    if (fresh.length === 0) {
      exhausted = true;
      break;
    }
    for (const post of fresh.sort((a, b) => b.messageId - a.messageId)) {
      if (seen.size >= maxScanned) break;
      seen.set(post.messageId, post);
      if (isUsable(post)) usable += 1;
    }
    before = Math.min(...fresh.map((post) => post.messageId));
    if (usable >= targetUsable || seen.size >= maxScanned) break;
    // The first message a channel has: nothing older to ask for.
    if (before <= 1) {
      exhausted = true;
      break;
    }
  }

  const parsed = toParsedHistory([...seen.values()], { username, title, publicationKey: input.publicationKey, targetUsable });
  return {
    title,
    parsed,
    inspected: seen.size,
    usable: parsed.items.length,
    exhausted,
    sha256: createHash('sha256').update(JSON.stringify(parsed.items)).digest('hex'),
  };
}

/** One page, waiting out a short rate limit in place. */
async function fetchPatiently(
  username: string,
  options: FetchChannelOptions & { before?: number },
  sleep: (ms: number) => Promise<void>,
): Promise<ChannelPage> {
  try {
    return await fetchChannelPage(username, options);
  } catch (error) {
    if (error instanceof ChannelPageError && error.code === 'channel_rate_limited') {
      const wait = error.retryAfterMs ?? 5_000;
      if (wait <= HISTORY_MAX_WAIT_MS) {
        await sleep(wait);
        return fetchChannelPage(username, options);
      }
    }
    throw error;
  }
}

/** Something to learn from: words, or something the channel chose to show. */
function isUsable(post: ChannelPagePost): boolean {
  return Boolean(post.text.trim()) || post.media.length > 0 || post.unsupported.length > 0;
}

/** The posts as canonical history items, the latest `targetUsable` usable ones, newest first. */
export function toParsedHistory(
  posts: ChannelPagePost[],
  input: { username: string; title: string | null; publicationKey: string; targetUsable?: number },
): ParsedPublicationHistory {
  const targetUsable = input.targetUsable ?? HISTORY_TARGET_USABLE_POSTS;
  const items: HistoricalPublicationItem[] = [];
  const skipped: HistoryImportIssue[] = [];

  for (const post of [...posts].sort((a, b) => b.messageId - a.messageId)) {
    const externalId = String(post.messageId);
    if (!post.publishedAt) {
      skipped.push({ externalId, reason: 'no_date' });
      continue;
    }
    if (!isUsable(post)) {
      skipped.push({ externalId, reason: 'no_text_or_media' });
      continue;
    }
    if (items.length >= targetUsable) {
      skipped.push({ externalId, reason: 'beyond_latest' });
      continue;
    }
    items.push(toItem(post, post.publishedAt));
  }

  return {
    platform: TELEGRAM_PLATFORM,
    publicationKey: input.publicationKey,
    publicationName: input.title,
    publicationMetadata: {
      username: input.username,
      ...(input.title ? { name: input.title } : {}),
      source: `https://t.me/s/${input.username}`,
    },
    itemsSeen: posts.length,
    items,
    skipped,
    failed: [],
    warnings: [],
  };
}

function toItem(post: ChannelPagePost, publishedAt: Date): HistoricalPublicationItem {
  const metadata: Record<string, unknown> = {};
  if (post.forwarded) metadata.forwarded = true;
  if (post.forwardedFrom) {
    metadata.forwardedFrom = post.forwardedFrom.username;
    if (post.forwardedFrom.messageId) metadata.forwardedFromMessageId = post.forwardedFrom.messageId;
  }
  if (post.outboundLinks?.length) metadata.outboundLinks = post.outboundLinks;

  return {
    externalId: String(post.messageId),
    contentType: 'post',
    title: null,
    text: post.text.trim() || null,
    publishedAt,
    editedAt: null,
    canonicalUrl: post.url,
    media: [
      ...post.media.map(
        (media): HistoricalMediaItem => ({
          type: media.kind,
          relativePath: null,
          available: false,
          ...(media.durationSeconds !== undefined ? { durationSeconds: media.durationSeconds } : {}),
        }),
      ),
      ...post.unsupported.map((what): HistoricalMediaItem => ({ type: mediaTypeOf(what), relativePath: null, available: false })),
    ],
    metrics: post.views === null ? null : { views: post.views },
    metadata: Object.keys(metadata).length > 0 ? metadata : null,
  };
}

/** What the page could not show, by its own words (src/lib/telegram-channel/parser.ts). */
function mediaTypeOf(what: string): HistoricalMediaItem['type'] {
  if (what.includes('video')) return 'video';
  if (what.includes('photo')) return 'photo';
  if (what === 'a file') return 'document';
  if (what === 'a sticker') return 'sticker';
  if (what === 'a voice message') return 'audio';
  return 'other';
}
