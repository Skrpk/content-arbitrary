import { escapeHtml, unescapeHtml } from '@/lib/telegram/format-caption';

/**
 * A workspace's post footer: a line added under every post it publishes —
 * the channel's name and link, say — written once in the workspace's
 * settings rather than by hand on each post.
 *
 * It is written as plain text with Markdown-style links:
 *
 *   [ВЕКТОР | космос · футуризм · sci-fi](https://t.me/vector_space2035)
 *
 * Everything else is text, escaped like any caption. Only http(s) and tg://
 * links become links; anything else in brackets stays as typed.
 *
 * The footer sits outside the editable caption: the editor shows it, but the
 * reviewer edits only the text above it, so a link cannot be broken by hand.
 */

export interface PostFooter {
  /** As Telegram's HTML parse mode takes it. */
  html: string;
  /** What a reader sees — what Telegram counts towards a length limit. */
  text: string;
}

/** Longest footer accepted, in visible characters: a signature, not a second post. */
export const POST_FOOTER_MAX = 200;

const LINK = /\[([^\]\n]+)\]\(((?:https?|tg):\/\/[^\s)]+)\)/g;

/** The footer to add, or null for none (unset, blank, or too long to be one). */
export function parsePostFooter(markup: string | null | undefined): PostFooter | null {
  const source = markup?.trim();
  if (!source) return null;

  let html = '';
  let text = '';
  let last = 0;
  for (const match of source.matchAll(LINK)) {
    const before = source.slice(last, match.index);
    const [, label, url] = match as unknown as [string, string, string];
    html += `${escapeHtml(before)}<a href="${escapeAttribute(url)}">${escapeHtml(label)}</a>`;
    text += before + label;
    last = match.index! + match[0].length;
  }
  html += escapeHtml(source.slice(last));
  text += source.slice(last);

  return text.length > POST_FOOTER_MAX ? null : { html, text };
}

/** The caption with the footer under it, as one HTML string. */
export function withFooter(captionHtml: string, footer: PostFooter | null | undefined): string {
  if (!footer) return captionHtml;
  return captionHtml === '' ? footer.html : `${captionHtml}\n\n${footer.html}`;
}

/** Visible characters the footer adds to a caption, separator included. */
export function footerLength(footer: PostFooter | null | undefined): number {
  return footer ? footer.text.length + 2 : 0;
}

/**
 * The caption without this footer, if it ends with it — what the editor
 * shows in its text box — or null when it does not: a post queued before
 * the footer was set or changed.
 */
export function stripFooter(captionHtml: string, footer: PostFooter | null | undefined): string | null {
  if (!footer) return null;
  if (captionHtml === footer.html) return '';
  const suffix = `\n\n${footer.html}`;
  return captionHtml.endsWith(suffix) ? captionHtml.slice(0, -suffix.length) : null;
}

/**
 * A stored caption as a reader sees it: links reduced to their text, entities
 * resolved. A caption's only tags are a footer's links — everything else was
 * escaped on the way in — so this is all the markup there is to remove.
 */
export function captionToPlainText(captionHtml: string): string {
  return unescapeHtml(captionHtml.replace(/<a\b[^>]*>/g, '').replace(/<\/a>/g, ''));
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}
