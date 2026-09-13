/**
 * Limits taken verbatim from the official Telegram Bot API documentation
 * (https://core.telegram.org/bots/api). Verified 2026-09-13.
 *
 * Keep this file as the single source of truth — do not inline these numbers
 * elsewhere, so that a future documentation change is a one-line edit.
 */

/** sendMessage: "Text of the message to be sent, 1-4096 characters". */
export const TELEGRAM_MESSAGE_TEXT_LIMIT = 4096;

/** sendPhoto/sendVideo/InputMedia*: "0-1024 characters after entities parsing". */
export const TELEGRAM_CAPTION_LIMIT = 1024;

/** sendMediaGroup: "must include 2-10 items". */
export const TELEGRAM_MEDIA_GROUP_MIN = 2;
export const TELEGRAM_MEDIA_GROUP_MAX = 10;

/**
 * "Sending files" section:
 *   - multipart/form-data: 10 MB max for photos, 50 MB for other files
 *   - by URL:               5 MB max for photos, 20 MB for other content
 */
export const TELEGRAM_UPLOAD_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const TELEGRAM_UPLOAD_FILE_MAX_BYTES = 50 * 1024 * 1024;
export const TELEGRAM_URL_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const TELEGRAM_URL_FILE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * sendPhoto: "The photo's width and height must not exceed 10000 in total.
 * Width and height ratio must be at most 20."
 */
export const TELEGRAM_PHOTO_MAX_DIMENSION_SUM = 10000;
export const TELEGRAM_PHOTO_MAX_ASPECT_RATIO = 20;

/**
 * Bot FAQ: "In a group, bots are not able to send more than 20 messages per
 * minute" and "avoid sending more than one message per second" in a single
 * chat. We pace album/message sends conservatively to stay under both.
 */
export const TELEGRAM_MIN_DELAY_BETWEEN_SENDS_MS = 1_100;

export type TelegramMediaKind = 'photo' | 'video';

export function maxUploadBytesFor(kind: TelegramMediaKind, mode: 'multipart' | 'url'): number {
  if (mode === 'url') {
    return kind === 'photo' ? TELEGRAM_URL_PHOTO_MAX_BYTES : TELEGRAM_URL_FILE_MAX_BYTES;
  }
  return kind === 'photo' ? TELEGRAM_UPLOAD_PHOTO_MAX_BYTES : TELEGRAM_UPLOAD_FILE_MAX_BYTES;
}

/**
 * Telegram rejects photos whose dimensions are out of range. We can detect
 * this before uploading because the X API gives us width/height, which turns a
 * failed API call into a cheap local `skipped`.
 */
export function photoDimensionsAreAcceptable(width?: number, height?: number): boolean {
  if (!width || !height) return true; // unknown — let Telegram decide
  if (width + height > TELEGRAM_PHOTO_MAX_DIMENSION_SUM) return false;
  const ratio = Math.max(width / height, height / width);
  return ratio <= TELEGRAM_PHOTO_MAX_ASPECT_RATIO;
}
