import { HTMLElement, NodeType, parse, type Node } from 'node-html-parser';
import { z } from 'zod';

/**
 * Reads a public channel's web page — `t.me/s/<channel>`, or one post's
 * embed — into its posts.
 *
 * This is the page Telegram serves anyone with a browser; it is not an API,
 * and nothing about its markup is promised. So the parser leans only on the
 * widget's long-standing class names, takes from each post just what the
 * pipeline needs, and checks what it took (postSchema) before it is used: a
 * post that does not come out whole is dropped rather than half-read.
 *
 * What the page cannot show it says so in place — a video too big for the
 * web player, a poll, a document — and that is reported as `unsupported`
 * rather than guessed at: like an X post whose video cannot be sent, such a
 * post is not published without the very thing that made it a post.
 */

export interface ChannelPageMedia {
  /** The message that holds it — an album's items are messages of their own. */
  key: string;
  kind: 'photo' | 'video';
  url: string;
  /** Video only: the still Telegram shows before it plays. */
  previewUrl?: string;
  durationSeconds?: number;
}

export interface ChannelPagePost {
  /** The channel's username as the page writes it in the post's id. */
  channel: string;
  messageId: number;
  url: string;
  publishedAt: Date | null;
  text: string;
  media: ChannelPageMedia[];
  /** What the post holds that the page does not show: one entry per thing. */
  unsupported: string[];
  /** Forwarded from another chat: someone else's post, as a repost on X is. */
  forwarded: boolean;
  views: number | null;
}

export interface ChannelPage {
  /** The channel's name as its header shows it; null on an embed. */
  title: string | null;
  posts: ChannelPagePost[];
}

/**
 * Media are fetched from wherever the page points, server-side — so only
 * from Telegram's own content hosts, whatever a page might say.
 */
const MEDIA_HOST = /(^|\.)(telesco\.pe|telegram\.org|telegram-cdn\.org)$/i;

const mediaUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && MEDIA_HOST.test(url.hostname);
  }, 'not a Telegram media URL');

const postSchema = z.object({
  channel: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{2,31}$/),
  messageId: z.number().int().positive(),
  url: z.string().url(),
  publishedAt: z.date().nullable(),
  text: z.string(),
  media: z.array(
    z.object({
      key: z.string().min(1),
      kind: z.enum(['photo', 'video']),
      url: mediaUrl,
      previewUrl: mediaUrl.optional(),
      durationSeconds: z.number().int().nonnegative().optional(),
    }),
  ),
  unsupported: z.array(z.string()),
  forwarded: z.boolean(),
  views: z.number().int().nonnegative().nullable(),
});

/** Kinds of message content the web page has no player for, by the class that marks them. */
const UNSUPPORTED_CONTENT: [string, string][] = [
  ['tgme_widget_message_document_wrap', 'a file'],
  ['tgme_widget_message_poll', 'a poll'],
  ['tgme_widget_message_sticker_wrap', 'a sticker'],
  ['tgme_widget_message_voice_player', 'a voice message'],
  ['tgme_widget_message_roundvideo_player', 'a video message'],
  ['tgme_widget_message_location_wrap', 'a location'],
  ['tgme_widget_message_venue_wrap', 'a location'],
  ['tgme_widget_message_contact_wrap', 'a contact'],
  ['tgme_widget_message_game', 'a game'],
  ['tgme_widget_message_invoice', 'an invoice'],
  ['tgme_widget_message_paid_media', 'paid media'],
];

export function parseChannelPage(html: string): ChannelPage {
  const root = parse(html, { comment: false });
  const title = clean(root.querySelector('.tgme_channel_info_header_title')?.text ?? '') || null;

  const posts: ChannelPagePost[] = [];
  for (const message of root.querySelectorAll('.tgme_widget_message[data-post]')) {
    // A message whose markup does not parse is left out, not allowed to fail the page.
    const read = readPost(message);
    if (!read) continue;
    const checked = postSchema.safeParse(read);
    if (checked.success) posts.push(checked.data);
  }
  return { title, posts };
}

function readPost(message: HTMLElement): ChannelPagePost | null {
  const id = /^([A-Za-z][A-Za-z0-9_]{2,31})\/(\d{1,12})$/.exec(message.getAttribute('data-post') ?? '');
  if (!id) return null;
  const channel = id[1]!;
  const messageId = Number(id[2]);

  // The post itself, not what it quotes: a reply's preview and a link's card
  // carry text and pictures of their own.
  const own = (element: HTMLElement) =>
    !element.closest('.tgme_widget_message_reply') &&
    !element.closest('.tgme_widget_message_link_preview') &&
    !element.closest('.media_not_supported_cont');

  const textElement = message.querySelectorAll('.tgme_widget_message_text').find(own);
  const datetime = message.querySelector('.tgme_widget_message_date time')?.getAttribute('datetime');
  const publishedAt = datetime && !Number.isNaN(Date.parse(datetime)) ? new Date(datetime) : null;

  const media: ChannelPageMedia[] = [];
  const unsupported: string[] = [];

  for (const element of message.querySelectorAll('.tgme_widget_message_photo_wrap, .tgme_widget_message_video_player').filter(own)) {
    const key = mediaKeyOf(element, channel, messageId, media.length);

    if (element.classList.contains('tgme_widget_message_photo_wrap')) {
      const url = backgroundImageOf(element);
      if (url) media.push({ key, kind: 'photo', url });
      else unsupported.push('a photo without a link');
      continue;
    }

    const src = element.querySelector('video')?.getAttribute('src');
    if (!src || element.classList.contains('not_supported')) {
      unsupported.push('a video too large for the web page');
      continue;
    }
    const thumb = element.querySelector('.tgme_widget_message_video_thumb');
    const previewUrl = thumb ? backgroundImageOf(thumb) : null;
    const duration = parseDuration(element.querySelector('.message_video_duration')?.text ?? '');
    media.push({
      key,
      kind: 'video',
      url: src,
      ...(previewUrl ? { previewUrl } : {}),
      ...(duration !== null ? { durationSeconds: duration } : {}),
    });
  }

  for (const [className, what] of UNSUPPORTED_CONTENT) {
    if (message.querySelectorAll(`.${className}`).some(own)) unsupported.push(what);
  }

  return {
    channel,
    messageId,
    url: `https://t.me/${channel}/${messageId}`,
    publishedAt,
    text: textElement ? textOf(textElement) : '',
    media,
    unsupported,
    forwarded: message.querySelector('.tgme_widget_message_forwarded_from') !== null,
    views: parseCount(message.querySelector('.tgme_widget_message_views')?.text ?? ''),
  };
}

/**
 * Which message an item is: an album's items each link to their own
 * (`t.me/channel/124?single`), a lone item to the post.
 */
function mediaKeyOf(element: HTMLElement, channel: string, messageId: number, index: number): string {
  const href = element.getAttribute('href') ?? '';
  const own = new RegExp(`^https://t\\.me/${channel}/(\\d{1,12})(?:\\?single)?$`, 'i').exec(href);
  return own ? `${channel.toLowerCase()}/${own[1]}` : `${channel.toLowerCase()}/${messageId}#${index}`;
}

function backgroundImageOf(element: HTMLElement): string | null {
  const style = element.getAttribute('style') ?? '';
  const match = /background-image:\s*url\((['"]?)(.*?)\1\)/i.exec(style);
  if (!match) return null;
  const url = match[2]!;
  return url.startsWith('//') ? `https:${url}` : url;
}

/** The post's text as plain text: line breaks kept, links as their words, emoji as characters. */
export function textOf(element: HTMLElement): string {
  let out = '';
  const walk = (node: Node) => {
    if (node.nodeType === NodeType.TEXT_NODE) {
      out += node.text;
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = node.tagName?.toLowerCase();
    if (tag === 'br') {
      out += '\n';
      return;
    }
    const block = tag === 'blockquote' || tag === 'pre' || tag === 'div' || tag === 'p';
    if (block && out !== '' && !out.endsWith('\n')) out += '\n';
    for (const child of node.childNodes) walk(child);
    if (block && !out.endsWith('\n')) out += '\n';
  };
  for (const child of element.childNodes) walk(child);
  return out
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** `653`, `77.5K`, `1.83M` — the page rounds; so does this. */
export function parseCount(text: string): number | null {
  const match = /^([\d.,]+)\s*([KMB])?$/i.exec(text.trim());
  if (!match) return null;
  const value = Number(match[1]!.replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  const scale = { K: 1e3, M: 1e6, B: 1e9 }[(match[2] ?? '').toUpperCase() as 'K' | 'M' | 'B'] ?? 1;
  return Math.round(value * scale);
}

/** `1:15` or `1:02:03`, in seconds. */
export function parseDuration(text: string): number | null {
  const parts = text.trim().split(':');
  if (parts.length < 2 || parts.length > 3 || !parts.every((part) => /^\d{1,2}$/.test(part))) return null;
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}
