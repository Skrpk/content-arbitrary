import { describeError, isTransient, retryAfterMsOf } from '@/lib/errors';
import type { Logger } from '@/lib/logger';

export interface RetryOptions {
  /** Total attempts, including the first one. */
  attempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injected in tests so the suite does not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
  label?: string;
  /** Ceiling on an honoured Telegram `retry_after`; beyond this we give up now. */
  maxRetryAfterMs?: number;
}

export const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Exponential backoff with full jitter.
 *
 * Jitter matters here because a single run publishes several posts in sequence;
 * without it, a Telegram rate limit would make every subsequent retry collide
 * on the same schedule.
 */
export function computeBackoffMs(
  attempt: number,
  baseDelayMs = 500,
  maxDelayMs = 30_000,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  // Full jitter, but never less than a quarter of the window, so we always
  // make some progress away from the previous attempt.
  return Math.round(exponential * (0.25 + 0.75 * random()));
}

/**
 * Run `operation`, retrying only transient failures.
 *
 * When the error carries an explicit `retry_after` (Telegram flood control) we
 * honour that value instead of our own backoff — Telegram is telling us exactly
 * how long it wants us to wait, and ignoring it makes the block worse.
 */
export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    attempts,
    baseDelayMs = 500,
    maxDelayMs = 30_000,
    sleep = defaultSleep,
    logger,
    label = 'operation',
    maxRetryAfterMs = 60_000,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isTransient(error)) {
        logger?.warn('retry.permanent_error', { label, attempt, error: describeError(error) });
        throw error;
      }

      if (attempt === attempts) {
        logger?.error('retry.exhausted', { label, attempts, error: describeError(error) });
        throw error;
      }

      const explicit = retryAfterMsOf(error);
      if (explicit !== undefined && explicit > maxRetryAfterMs) {
        logger?.error('retry.retry_after_too_long', { label, retryAfterMs: explicit, maxRetryAfterMs });
        throw error;
      }

      const delay = explicit ?? computeBackoffMs(attempt, baseDelayMs, maxDelayMs);
      logger?.warn('retry.scheduled', {
        label,
        attempt,
        nextAttempt: attempt + 1,
        delayMs: delay,
        honouredRetryAfter: explicit !== undefined,
        error: describeError(error),
      });

      await sleep(delay);
    }
  }

  throw lastError;
}
