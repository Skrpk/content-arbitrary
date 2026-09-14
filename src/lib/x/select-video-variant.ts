import { formatBytes } from '@/lib/x/download-media';
import type { Logger } from '@/lib/logger';
import type { Mp4Variant, NormalizedMedia } from '@/types';

/**
 * Picks the best MP4 rendition of an X video that fits a size budget.
 *
 * X publishes the same video at several bitrates (typically 320p / 480p / 720p
 * or 1080p). Sending the largest one and giving up when it exceeds Telegram's
 * limit throws away a perfectly good smaller rendition that X already encoded
 * for us — so this is a cheaper and lossless-in-effort alternative to
 * transcoding, which would need FFmpeg and CPU time we do not have on a
 * serverless function.
 *
 * Variants are probed from highest bitrate down and the first that fits wins,
 * so the common case (the best rendition already fits) costs one HEAD request.
 */

export interface ProbedVariant {
  bitRate?: number;
  sizeBytes?: number;
  /** How sizeBytes was obtained, for logging. */
  sizeSource: 'content-length' | 'content-range' | 'estimated' | 'unknown';
}

export interface VideoVariantSelection {
  url: string;
  bitRate?: number;
  contentType: string;
  sizeBytes?: number;
  selectionReason: string;
}

export type VideoVariantResult =
  | ({ fits: true } & VideoVariantSelection)
  | { fits: false; reason: string; candidates: ProbedVariant[] };

/**
 * Ask the CDN how large a file is without downloading it.
 *
 * HEAD is tried first. Some CDNs do not answer HEAD but do honour a one-byte
 * range request, whose `Content-Range: bytes 0-0/12345` carries the total, so
 * that is the fallback. Both are a few hundred bytes on the wire.
 */
export async function probeVariantSize(
  url: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ sizeBytes?: number; sizeSource: ProbedVariant['sizeSource'] }> {
  try {
    const head = await fetchImpl(url, { method: 'HEAD', signal, cache: 'no-store' });
    if (head.ok) {
      const length = Number(head.headers.get('content-length') ?? Number.NaN);
      if (Number.isFinite(length) && length > 0) {
        return { sizeBytes: length, sizeSource: 'content-length' };
      }
    }
  } catch {
    // Fall through to the range request.
  }

  try {
    const ranged = await fetchImpl(url, {
      method: 'GET',
      headers: { range: 'bytes=0-0' },
      signal,
      cache: 'no-store',
    });

    // Release the (one byte) body so the connection can be reused.
    await ranged.body?.cancel().catch(() => {});

    const contentRange = ranged.headers.get('content-range');
    const total = contentRange?.match(/\/(\d+)\s*$/)?.[1];
    if (total) {
      const parsed = Number(total);
      if (Number.isFinite(parsed) && parsed > 0) {
        return { sizeBytes: parsed, sizeSource: 'content-range' };
      }
    }
  } catch {
    // Size stays unknown; the caller falls back to an estimate.
  }

  return { sizeSource: 'unknown' };
}

/**
 * Approximate size from the declared bitrate and duration.
 *
 * Only used when the CDN reports no size at all. It ignores container overhead
 * and audio, so it is a lower bound — which is why a probed Content-Length is
 * always preferred.
 */
export function estimateSizeBytes(bitRate?: number, durationSeconds?: number): number | undefined {
  if (!bitRate || !durationSeconds) return undefined;
  return Math.round((bitRate * durationSeconds) / 8);
}

export async function selectTelegramVideoVariant(
  media: NormalizedMedia,
  maxBytes: number,
  options?: { fetchImpl?: typeof fetch; logger?: Logger; signal?: AbortSignal },
): Promise<VideoVariantResult> {
  const fetchImpl = options?.fetchImpl ?? fetch;

  const variants = [...(media.mp4Variants ?? [])].sort(
    (a, b) => (b.bitRate ?? 0) - (a.bitRate ?? 0),
  );

  if (variants.length === 0) {
    return {
      fits: false,
      reason: `video ${media.mediaKey} has no progressive MP4 variant`,
      candidates: [],
    };
  }

  const candidates: ProbedVariant[] = [];

  for (const [index, variant] of variants.entries()) {
    const probed = await probeVariantSize(variant.url, fetchImpl, options?.signal);

    let sizeBytes = probed.sizeBytes;
    let sizeSource = probed.sizeSource;

    if (sizeBytes === undefined) {
      const estimated = estimateSizeBytes(variant.bitRate, media.durationSeconds);
      if (estimated !== undefined) {
        sizeBytes = estimated;
        sizeSource = 'estimated';
      }
    }

    candidates.push({ bitRate: variant.bitRate, sizeBytes, sizeSource });

    options?.logger?.debug('video.variant_probed', {
      mediaKey: media.mediaKey,
      bitRate: variant.bitRate,
      sizeBytes,
      sizeSource,
      fits: sizeBytes === undefined ? 'unknown' : sizeBytes <= maxBytes,
    });

    // Size genuinely unknown: try it rather than discard a possibly fine video.
    // The download guard still aborts mid-stream if it turns out to be too big.
    if (sizeBytes === undefined) {
      return {
        fits: true,
        url: variant.url,
        bitRate: variant.bitRate,
        contentType: variant.contentType,
        selectionReason:
          index === 0
            ? 'highest-bitrate MP4; size unknown, accepted optimistically'
            : `MP4 #${index + 1} by bitrate; size unknown, accepted optimistically`,
      };
    }

    if (sizeBytes <= maxBytes) {
      return {
        fits: true,
        url: variant.url,
        bitRate: variant.bitRate,
        contentType: variant.contentType,
        sizeBytes,
        selectionReason:
          index === 0
            ? `highest-bitrate MP4 fits (${formatBytes(sizeBytes)} <= ${formatBytes(maxBytes)})`
            : `downgraded to MP4 #${index + 1} of ${variants.length} by bitrate ` +
              `(${formatBytes(sizeBytes)} <= ${formatBytes(maxBytes)}); ` +
              'larger renditions exceeded the limit',
      };
    }
  }

  const smallest = candidates.reduce<number | undefined>(
    (min, candidate) =>
      candidate.sizeBytes !== undefined && (min === undefined || candidate.sizeBytes < min)
        ? candidate.sizeBytes
        : min,
    undefined,
  );

  return {
    fits: false,
    reason:
      `all ${variants.length} MP4 variant(s) of ${media.mediaKey} exceed ` +
      `${formatBytes(maxBytes)}` +
      (smallest !== undefined ? `; smallest is ${formatBytes(smallest)}` : ''),
    candidates,
  };
}

export type { Mp4Variant };
