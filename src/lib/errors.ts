/**
 * Error taxonomy shared by the X and Telegram clients.
 *
 * The single most important distinction in this application is
 * transient vs permanent:
 *   - transient  → retry with backoff (network blip, 5xx, 429);
 *   - permanent  → record the reason and never try again (file too large,
 *                  unsupported format, bot not in the channel).
 *
 * Getting this wrong in either direction is costly: retrying a permanent error
 * burns the X quota forever, while giving up on a transient one silently drops
 * a post.
 */

export class AppError extends Error {
  readonly transient: boolean;
  readonly retryAfterMs?: number;
  readonly code: string;

  constructor(
    message: string,
    options: { transient: boolean; code: string; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.transient = options.transient;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Failure talking to the X API. */
export class XApiError extends AppError {
  readonly status?: number;

  constructor(
    message: string,
    options: { transient: boolean; code: string; status?: number; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, options);
    this.status = options.status;
  }
}

/** Failure talking to the Telegram Bot API. */
export class TelegramApiError extends AppError {
  readonly status?: number;
  readonly description?: string;

  constructor(
    message: string,
    options: {
      transient: boolean;
      code: string;
      status?: number;
      description?: string;
      retryAfterMs?: number;
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.status = options.status;
    this.description = options.description;
  }
}

/** The post can never be published as-is — record and move on. */
export class MediaUnsupportedError extends AppError {
  constructor(message: string, code = 'media_unsupported') {
    super(message, { transient: false, code });
  }
}

export function isTransient(error: unknown): boolean {
  if (error instanceof AppError) return error.transient;
  // Undici/Node network failures are worth another attempt.
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) return true;
  if (error instanceof Error && /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|aborted/i.test(error.message)) {
    return true;
  }
  return false;
}

export function retryAfterMsOf(error: unknown): number | undefined {
  return error instanceof AppError ? error.retryAfterMs : undefined;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
