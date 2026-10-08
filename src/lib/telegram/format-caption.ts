import { TELEGRAM_CAPTION_LIMIT, TELEGRAM_MESSAGE_TEXT_LIMIT } from '@/lib/telegram/limits';
import { footerLength, withFooter, type PostFooter } from '@/lib/telegram/post-footer';

/**
 * Caption construction.
 *
 * Parse mode is HTML rather than MarkdownV2, deliberately. MarkdownV2 requires
 * escaping 18 different characters anywhere they appear, and a single missed one
 * makes Telegram reject the whole message with "can't parse entities". HTML
 * needs exactly three characters escaped, which is far harder to get wrong on
 * arbitrary user-authored text.
 */

export const TELEGRAM_PARSE_MODE = 'HTML' as const;

/** Escape the three characters that are special in Telegram's HTML subset. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Reverse `escapeHtml`.
 *
 * Captions are stored escaped, so the editor has to show the plain text the
 * reviewer actually wrote. The order matters: resolving `&amp;` last is what
 * makes the round trip lossless for text that itself contained an entity.
 */
export function unescapeHtml(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export interface CaptionOptions {
  text: string;
  username: string;
  postId: string;
  includeSourceLink: boolean;
  /**
   * The line that names the source, in place of X's `Source: https://x.com/…`
   * — for a feed entry, the article's URL on its own.
   */
  sourceLine?: string;
  prefix?: string;
  suffix?: string;
  /**
   * The workspace's footer, last of all and already HTML (it may link). It
   * goes under the caption and under the full-text follow-up alike, and is
   * never shortened: its length is set aside before the text is fitted.
   */
  footer?: PostFooter | null;
}

export interface CaptionResult {
  /** HTML-formatted caption, guaranteed to fit the caption limit. */
  caption: string;
  /**
   * Set when the post was too long for a caption: the media goes out with
   * `caption`, and this full text follows as its own message.
   */
  overflowMessage?: string;
  truncated: boolean;
}

export function buildSourceLine(username: string, postId: string): string {
  return `Source: https://x.com/${username.replace(/^@/, '')}/status/${postId}`;
}

function sourceLineOf(options: CaptionOptions): string {
  return options.sourceLine ?? buildSourceLine(options.username, options.postId);
}

/**
 * Assemble the plain-text body, in the order the channel should read:
 *
 *   [prefix]
 *   <original post text>
 *   Source: https://x.com/user/status/123
 *   [suffix]
 *
 * Nothing else is added — no "via", no bot signature.
 */
export function composePlainText(options: CaptionOptions): string {
  const blocks: string[] = [];

  if (options.prefix && options.prefix.trim() !== '') blocks.push(options.prefix.trim());
  if (options.text.trim() !== '') blocks.push(options.text.trim());
  if (options.includeSourceLink) blocks.push(sourceLineOf(options));
  if (options.suffix && options.suffix.trim() !== '') blocks.push(options.suffix.trim());

  return blocks.join('\n\n');
}

/**
 * Truncate without splitting a grapheme cluster.
 *
 * Telegram counts message length in UTF-16 code units, but cutting at an
 * arbitrary code unit can split a surrogate pair (producing a replacement
 * character) or tear apart an emoji sequence such as a flag or a skin-tone
 * modifier. Segmenting first means we only ever cut between user-perceived
 * characters.
 */
export function truncateToLength(text: string, limit: number): string {
  if (text.length <= limit) return text;

  const segmenter =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      : null;

  let out = '';

  if (segmenter) {
    for (const { segment } of segmenter.segment(text)) {
      if (out.length + segment.length > limit) break;
      out += segment;
    }
  } else {
    // Fallback: iterate code points, which at least never splits a surrogate pair.
    for (const codePoint of text) {
      if (out.length + codePoint.length > limit) break;
      out += codePoint;
    }
  }

  return out;
}

/** Truncate to `limit`, reserving room for an ellipsis, preferring a word boundary. */
export function truncateForDisplay(text: string, limit: number): string {
  if (text.length <= limit) return text;

  const ellipsis = '…';
  const clipped = truncateToLength(text, Math.max(0, limit - ellipsis.length));

  // Prefer to end on whitespace, but only if that does not throw away too much.
  const lastBreak = Math.max(clipped.lastIndexOf(' '), clipped.lastIndexOf('\n'));
  const body = lastBreak > clipped.length * 0.6 ? clipped.slice(0, lastBreak) : clipped;

  return `${body.trimEnd()}${ellipsis}`;
}

/**
 * Build the caption for a media message.
 *
 * If the full text fits within Telegram's 1024-character caption limit it is
 * used as-is. If it does not, the media carries a shortened caption and the
 * complete text is returned as `overflowMessage` to be sent immediately after,
 * so nothing the author wrote is lost — unless it is longer than even a text
 * message may be, in which case that too is shortened the same way.
 */
export function formatCaption(options: CaptionOptions): CaptionResult {
  const plain = composePlainText(options);
  const reserved = footerLength(options.footer);
  const finish = (text: string) => withFooter(escapeHtml(text), options.footer);

  if (plain.length + reserved <= TELEGRAM_CAPTION_LIMIT) {
    return { caption: finish(plain), truncated: false };
  }

  return {
    caption: finish(fitToLimit(options, plain, TELEGRAM_CAPTION_LIMIT - reserved)),
    overflowMessage: finish(fitToLimit(options, plain, TELEGRAM_MESSAGE_TEXT_LIMIT - reserved)),
    truncated: true,
  };
}

/**
 * Build the message for a post with no media, which goes out as plain text.
 *
 * The same framing as a caption, under the larger message limit, and with no
 * follow-up: anything past 4096 characters is shortened the way an overlong
 * caption is — the author's text gives way, the framing stays.
 */
export function formatTextPost(options: CaptionOptions): string {
  const limit = TELEGRAM_MESSAGE_TEXT_LIMIT - footerLength(options.footer);
  return withFooter(escapeHtml(fitToLimit(options, composePlainText(options), limit)), options.footer);
}

/**
 * The composed text, shortened to `limit` if it must be.
 */
function fitToLimit(options: CaptionOptions, plain: string, limit: number): string {
  if (plain.length <= limit) return plain;

  /**
   * Only the author's prose is shortened. The prefix, suffix and source line
   * are operator-controlled framing — typically a call to action or an
   * attribution that must appear under every post — so dropping them on a long
   * post would silently defeat the reason they were configured.
   */
  const prefix = options.prefix?.trim() ?? '';
  const suffix = options.suffix?.trim() ?? '';
  const sourceLine = options.includeSourceLink ? sourceLineOf(options) : '';

  const separator = '\n\n';
  const framing = [prefix, sourceLine, suffix].filter((part) => part !== '');
  const reserved = framing.reduce(
    (total, part) => total + part.length + separator.length,
    0,
  );

  const shortText = truncateForDisplay(options.text.trim(), Math.max(0, limit - reserved));

  const shortened = [prefix, shortText, sourceLine, suffix]
    .filter((part) => part !== '')
    .join(separator);

  return truncateToLength(shortened, limit);
}

/** Format a standalone text message, clamped to the 4096-character limit. */
export function formatMessageText(text: string): string {
  return escapeHtml(truncateToLength(text, TELEGRAM_MESSAGE_TEXT_LIMIT));
}
