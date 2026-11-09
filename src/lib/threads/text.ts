import { htmlToText } from '@/lib/rss/text';

/**
 * A post's text, the way Threads takes it: plain, and within its length.
 *
 * Threads allows 500 characters, counting an emoji as its UTF-8 bytes. A
 * longer text-only post keeps the whole of its text as a text attachment
 * (up to 10,000 characters) under a first part that fits; a post with media
 * cannot have one, so its text is cut.
 */

export const THREADS_TEXT_LIMIT = 500;
export const THREADS_ATTACHMENT_LIMIT = 10_000;
/** Headroom under the limit, for a count that might differ from ours at the edges. */
const BUDGET = THREADS_TEXT_LIMIT - 10;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

/** The length Threads counts: a character each, an emoji as its bytes. */
export function threadsLength(text: string): number {
  let length = 0;
  for (const { segment } of segmenter.segment(text)) {
    length += PICTOGRAPHIC.test(segment) ? Buffer.byteLength(segment, 'utf8') : 1;
  }
  return length;
}

/** Telegram HTML — a caption as stored — as plain text, a link's address kept where its words hide it. */
export function telegramHtmlToText(html: string): string {
  const withLinks = html.replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) => {
    const words = htmlToText(label);
    const address = href.replace(/&amp;/g, '&');
    return words.includes(address) || !/^https?:\/\//i.test(address) ? label : `${label} (${address})`;
  });
  return htmlToText(withLinks.replace(/\n/g, '<br>'));
}

/** As much of the text as fits, cut at a paragraph, a sentence or a word, with an ellipsis. */
export function cutForThreads(text: string, budget = BUDGET): string {
  if (threadsLength(text) <= budget) return text;
  let kept = '';
  let length = 0;
  for (const { segment } of segmenter.segment(text)) {
    const size = PICTOGRAPHIC.test(segment) ? Buffer.byteLength(segment, 'utf8') : 1;
    if (length + size > budget - 1) break;
    kept += segment;
    length += size;
  }
  const breakAt = Math.max(kept.lastIndexOf('\n\n'), kept.lastIndexOf('. '), kept.lastIndexOf('! '), kept.lastIndexOf('? '));
  const cut = breakAt > kept.length * 0.6 ? kept.slice(0, breakAt + 1) : kept.slice(0, Math.max(kept.lastIndexOf(' '), kept.length * 0.8));
  return `${cut.trimEnd()}…`;
}

export interface ThreadsText {
  text: string;
  /** The whole text, when it did not fit and the post can carry it. */
  attachment: string | null;
}

export function threadsTextFor(fullText: string, hasMedia: boolean): ThreadsText {
  const text = fullText.trim();
  if (threadsLength(text) <= BUDGET) return { text, attachment: null };
  if (hasMedia) return { text: cutForThreads(text), attachment: null };
  return { text: cutForThreads(text), attachment: text.slice(0, THREADS_ATTACHMENT_LIMIT) };
}
