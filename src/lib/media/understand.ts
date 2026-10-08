import type { MediaUnderstandingRow } from '@/db/schema';
import type { Database } from '@/lib/db';
import { describeError } from '@/lib/errors';
import { scrub, type Logger } from '@/lib/logger';
import { imageFingerprint, sniffImageType } from '@/lib/media/image';
import { ImageUnderstandingError, type ImageUnderstander } from '@/lib/media/provider';
import { findUnderstanding, saveUnderstanding, understandingOf } from '@/lib/media/repository';
import {
  MEDIA_UNDERSTANDING_MAX_BYTES,
  type ImageUnderstanding,
  type MediaUnderstandingConfig,
} from '@/lib/media/understanding';
import { costUsd } from '@/lib/radar/report';

/**
 * Understand one image, at most once: its stored understanding if there is
 * one for the current model and prompt, otherwise one vision call, stored.
 *
 * Enrichment, never a dependency. It never throws: an unsupported or
 * oversized image, a timeout, a refusal or a database error all end in a
 * result without an understanding, and whatever came next — Radar, review,
 * publishing — goes on as it did before images were understood.
 */

export interface ImageUnderstandingResult {
  /** SHA-256 of the bytes; null when there were no usable bytes to hash. */
  fingerprint: string | null;
  understanding: ImageUnderstanding | null;
  /** The stored row it came from or was saved as; null without one. */
  row: MediaUnderstandingRow | null;
  /** Taken from storage, not paid for now. */
  cached: boolean;
}

const UNDERSTANDING_TIMEOUT_MS = 20_000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000;

/**
 * An image's bytes, for a post whose send did not download them — capped, so
 * a huge file is refused rather than read. Null on any failure: the caller
 * goes on without an understanding.
 */
export async function downloadImage(
  url: string,
  options: { fetchImpl?: typeof fetch; logger?: Logger } = {},
): Promise<Uint8Array | null> {
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MEDIA_UNDERSTANDING_MAX_BYTES) throw new Error('too large');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MEDIA_UNDERSTANDING_MAX_BYTES) throw new Error('too large');
    return bytes;
  } catch (error) {
    options.logger?.warn('media.image_unavailable', { error: describeError(error) });
    return null;
  }
}

export async function understandImage(input: {
  db: Database;
  understander: ImageUnderstander;
  config: MediaUnderstandingConfig;
  bytes: Uint8Array;
  /** The post's text, as context for what the image shows. */
  caption?: string | null;
  timeoutMs?: number;
  logger?: Logger;
}): Promise<ImageUnderstandingResult> {
  const mediaType = sniffImageType(input.bytes);
  if (!mediaType || input.bytes.byteLength > MEDIA_UNDERSTANDING_MAX_BYTES) {
    input.logger?.info('media.understanding_skipped', {
      reason: mediaType ? 'too large' : 'not a supported image',
      byteLength: input.bytes.byteLength,
    });
    return { fingerprint: mediaType ? imageFingerprint(input.bytes) : null, understanding: null, row: null, cached: false };
  }

  const fingerprint = imageFingerprint(input.bytes);
  try {
    const existing = await findUnderstanding(input.db, { fingerprint, config: input.config });
    if (existing?.status === 'ok') {
      input.logger?.info('media.understanding_reused', { understandingId: existing.id });
      return { fingerprint, understanding: understandingOf(existing), row: existing, cached: true };
    }

    const startedAt = Date.now();
    let result: Awaited<ReturnType<ImageUnderstander['understand']>> | null = null;
    let failure: unknown = null;
    try {
      result = await input.understander.understand(
        { bytes: input.bytes, mediaType },
        { caption: input.caption, timeoutMs: input.timeoutMs ?? UNDERSTANDING_TIMEOUT_MS },
      );
    } catch (error) {
      failure = error;
    }

    const usage = result ?? (failure instanceof ImageUnderstandingError ? failure.usage : undefined);
    const row = await saveUnderstanding(input.db, {
      fingerprint,
      config: input.config,
      understanding: result?.understanding ?? null,
      error: failure ? scrub(describeError(failure)).slice(0, 500) : undefined,
      mediaType,
      byteLength: input.bytes.byteLength,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      costUsd: usage ? costUsd(input.config.model, usage) : null,
      latencyMs: Date.now() - startedAt,
    });

    if (failure) {
      input.logger?.warn('media.understanding_failed', { understandingId: row.id, error: describeError(failure) });
      return { fingerprint, understanding: null, row, cached: false };
    }
    input.logger?.info('media.understood', {
      understandingId: row.id,
      contentType: row.contentType,
      informationValue: row.informationValue,
      latencyMs: row.latencyMs,
      // Not `inputTokens`: the logger redacts any key named *token*.
      usage: { input: row.inputTokens, output: row.outputTokens },
    });
    return { fingerprint, understanding: understandingOf(row), row, cached: false };
  } catch (error) {
    input.logger?.warn('media.understanding_failed', { error: describeError(error) });
    return { fingerprint, understanding: null, row: null, cached: false };
  }
}
