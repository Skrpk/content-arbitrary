import { TELEGRAM_CAPTION_LIMIT, TELEGRAM_MESSAGE_TEXT_LIMIT } from '@/lib/telegram/limits';

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

export interface CaptionOptions {
  text: string;
  username: string;
  postId: string;
  includeSourceLink: boolean;
  prefix?: string;
  suffix?: string;
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
  if (options.includeSourceLink) blocks.push(buildSourceLine(options.username, options.postId));
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
 * so nothing the author wrote is lost.
 */
export function formatCaption(options: CaptionOptions): CaptionResult {
  const plain = composePlainText(options);

  if (plain.length <= TELEGRAM_CAPTION_LIMIT) {
    return { caption: escapeHtml(plain), truncated: false };
  }

  // The source link is the part a reader most needs, so it stays in the caption
  // while the prose moves to the follow-up message.
  const sourceLine = options.includeSourceLink
    ? buildSourceLine(options.username, options.postId)
    : '';

  const reserved = sourceLine === '' ? 0 : sourceLine.length + 2;
  const shortText = truncateForDisplay(
    options.text.trim(),
    Math.max(0, TELEGRAM_CAPTION_LIMIT - reserved),
  );

  const captionPlain = [shortText, sourceLine].filter((part) => part !== '').join('\n\n');

  return {
    caption: escapeHtml(truncateToLength(captionPlain, TELEGRAM_CAPTION_LIMIT)),
    overflowMessage: escapeHtml(truncateToLength(plain, TELEGRAM_MESSAGE_TEXT_LIMIT)),
    truncated: true,
  };
}

/** Format a standalone text message, clamped to the 4096-character limit. */
export function formatMessageText(text: string): string {
  return escapeHtml(truncateToLength(text, TELEGRAM_MESSAGE_TEXT_LIMIT));
}
