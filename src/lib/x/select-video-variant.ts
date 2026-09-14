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
 * Selection has two tiers:
 *   - a *preferred* budget, met by the best rendition at or under it — used to
 *     keep channel downloads light when X offers a suitable smaller encode;
 *   - a *hard* ceiling, which nothing may exceed (Telegram's own upload limit,
 *     or a lower operator cap).
 *
 * When no rendition meets the preferred budget, the best one within the hard
 * ceiling is sent rather than nothing: a large original beats a skipped post.
 *
 * Variants are probed from highest bitrate down, so the common case (the best
 * rendition already meets the preferred budget) costs one HEAD request.
 */

export interface ProbedVariant {
  bitRate?: number;
  sizeBytes?: number;
  /** How sizeBytes was obtained, for logging. */
  sizeSource: 'content-length' | 'content-range' | 'estimated' | 'unknown';
}

export interface VideoBudget {
  /**
   * Preferred ceiling. The best rendition at or under it wins outright.
   * Omit for "always the best quality that fits".
   */
  preferredMaxBytes?: number;
  /** Absolute ceiling. Nothing above this can be sent at all. */
  maxBytes: number;
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
  budget: VideoBudget,
  options?: { fetchImpl?: typeof fetch; logger?: Logger; signal?: AbortSignal },
): Promise<VideoVariantResult> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const maxBytes = budget.maxBytes;
  // A preferred budget above the hard ceiling is meaningless; clamp it.
  const preferred =
    budget.preferredMaxBytes === undefined
      ? undefined
      : Math.min(budget.preferredMaxBytes, maxBytes);

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

  /**
   * Best rendition within the hard ceiling. Because we walk from the highest
   * bitrate down, the first one that fits is the best one, so this is only ever
   * set once — it is the fallback if nothing meets the preferred budget.
   */
  let fallback: (VideoVariantSelection & { index: number }) | undefined;

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
      withinPreferred: sizeBytes !== undefined && preferred !== undefined
        ? sizeBytes <= preferred
        : 'unknown',
      withinMax: sizeBytes === undefined ? 'unknown' : sizeBytes <= maxBytes,
    });

    const base = {
      url: variant.url,
      bitRate: variant.bitRate,
      contentType: variant.contentType,
      sizeBytes,
      index,
    };

    /**
     * Size genuinely unknowable: keep it as a fallback rather than discard a
     * possibly fine video, but keep looking for a smaller rendition whose size
     * we can actually confirm against the preferred budget. The download guard
     * still aborts mid-stream if it turns out to be too large.
     */
    if (sizeBytes === undefined) {
      fallback ??= {
        ...base,
        selectionReason:
          `${describePosition(index, variants.length)}; size unknown, accepted optimistically`,
      };
      continue;
    }

    if (sizeBytes > maxBytes) continue;

    fallback ??= {
      ...base,
      selectionReason:
        `${describePosition(index, variants.length)} fits the ${formatBytes(maxBytes)} limit ` +
        `(${formatBytes(sizeBytes)})`,
    };

    // Preferred budget met: this is the best such rendition, so stop here.
    if (preferred === undefined || sizeBytes <= preferred) {
      return {
        fits: true,
        ...base,
        selectionReason:
          preferred === undefined
            ? `${describePosition(index, variants.length)} fits (${formatBytes(sizeBytes)} <= ${formatBytes(maxBytes)})`
            : `${describePosition(index, variants.length)} meets the preferred ` +
              `${formatBytes(preferred)} budget (${formatBytes(sizeBytes)})`,
      };
    }
  }

  if (fallback) {
    const { index, ...selection } = fallback;
    void index;
    return {
      fits: true,
      ...selection,
      selectionReason:
        preferred === undefined
          ? selection.selectionReason
          : `no rendition under the preferred ${formatBytes(preferred)}; ` +
            `keeping the original — ${selection.selectionReason}`,
    };
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

function describePosition(index: number, total: number): string {
  return index === 0 ? 'highest-bitrate MP4' : `MP4 #${index + 1} of ${total} by bitrate`;
}

export type { Mp4Variant };
