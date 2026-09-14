import { describe, expect, it, vi } from 'vitest';
import {
  estimateSizeBytes,
  probeVariantSize,
  selectTelegramVideoVariant,
} from '@/lib/x/select-video-variant';
import { listMp4Variants } from '@/lib/x/normalize-post';
import type { NormalizedMedia } from '@/types';
import type { XMedia } from '@/lib/x/schemas';
import { createTestLogger } from './helpers';

const MB = 1024 * 1024;

/** A video with the three renditions X typically publishes. */
function video(overrides?: Partial<NormalizedMedia>): NormalizedMedia {
  return {
    mediaKey: '7_1',
    kind: 'video',
    url: 'https://video.twimg.com/high.mp4',
    durationSeconds: 46,
    mp4Variants: [
      { url: 'https://video.twimg.com/high.mp4', bitRate: 2176000, contentType: 'video/mp4' },
      { url: 'https://video.twimg.com/mid.mp4', bitRate: 832000, contentType: 'video/mp4' },
      { url: 'https://video.twimg.com/low.mp4', bitRate: 256000, contentType: 'video/mp4' },
    ],
    ...overrides,
  };
}

/** Serves HEAD responses from a url → size map. */
function sizeServer(sizes: Record<string, number | null>) {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const size = sizes[url];

    if (size === undefined) return new Response(null, { status: 404 });

    if (init?.method === 'HEAD') {
      if (size === null) return new Response(null, { status: 200 }); // no content-length
      return new Response(null, { status: 200, headers: { 'content-length': String(size) } });
    }

    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

describe('probeVariantSize', () => {
  it('reads Content-Length from a HEAD request', async () => {
    const fetchImpl = sizeServer({ 'https://v/a.mp4': 5 * MB });
    const result = await probeVariantSize('https://v/a.mp4', fetchImpl);

    expect(result).toEqual({ sizeBytes: 5 * MB, sizeSource: 'content-length' });
  });

  it('falls back to a one-byte range request when HEAD gives no length', async () => {
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 405 });
      expect((init?.headers as Record<string, string>).range).toBe('bytes=0-0');
      return new Response(new Uint8Array(1), {
        status: 206,
        headers: { 'content-range': `bytes 0-0/${12 * MB}` },
      });
    }) as unknown as typeof fetch;

    const result = await probeVariantSize('https://v/a.mp4', fetchImpl);
    expect(result).toEqual({ sizeBytes: 12 * MB, sizeSource: 'content-range' });
  });

  it('reports unknown when the CDN offers neither', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const result = await probeVariantSize('https://v/a.mp4', fetchImpl);

    expect(result.sizeBytes).toBeUndefined();
    expect(result.sizeSource).toBe('unknown');
  });

  it('does not throw when the network fails outright', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    await expect(probeVariantSize('https://v/a.mp4', fetchImpl)).resolves.toMatchObject({
      sizeSource: 'unknown',
    });
  });
});

describe('estimateSizeBytes', () => {
  it('derives bytes from bitrate and duration', () => {
    // 2176000 bits/s over 46 s ≈ 12.5 MB
    expect(estimateSizeBytes(2176000, 46)).toBe(Math.round((2176000 * 46) / 8));
  });

  it('returns undefined when either input is missing', () => {
    expect(estimateSizeBytes(undefined, 46)).toBeUndefined();
    expect(estimateSizeBytes(2176000, undefined)).toBeUndefined();
  });
});

describe('selectTelegramVideoVariant', () => {
  const logger = createTestLogger();

  it('keeps the highest bitrate when it already fits', async () => {
    const fetchImpl = sizeServer({
      'https://video.twimg.com/high.mp4': 8 * MB,
      'https://video.twimg.com/mid.mp4': 3 * MB,
      'https://video.twimg.com/low.mp4': 1 * MB,
    });

    const result = await selectTelegramVideoVariant(video(), { maxBytes: 10 * MB }, { fetchImpl, logger });

    expect(result.fits).toBe(true);
    if (!result.fits) return;
    expect(result.url).toBe('https://video.twimg.com/high.mp4');
    expect(result.sizeBytes).toBe(8 * MB);
    expect(result.selectionReason).toMatch(/highest-bitrate MP4 fits/);
  });

  it('probes only once when the best rendition fits', async () => {
    const fetchImpl = sizeServer({
      'https://video.twimg.com/high.mp4': 8 * MB,
      'https://video.twimg.com/mid.mp4': 3 * MB,
      'https://video.twimg.com/low.mp4': 1 * MB,
    });

    await selectTelegramVideoVariant(video(), { maxBytes: 10 * MB }, { fetchImpl, logger });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('downgrades to the best rendition that fits', async () => {
    const fetchImpl = sizeServer({
      'https://video.twimg.com/high.mp4': 24 * MB,
      'https://video.twimg.com/mid.mp4': 7 * MB,
      'https://video.twimg.com/low.mp4': 2 * MB,
    });

    const result = await selectTelegramVideoVariant(video(), { maxBytes: 10 * MB }, { fetchImpl, logger });

    expect(result.fits).toBe(true);
    if (!result.fits) return;
    expect(result.url).toBe('https://video.twimg.com/mid.mp4');
    expect(result.bitRate).toBe(832000);
    expect(result.selectionReason).toMatch(/MP4 #2 of 3 by bitrate/);
  });

  it('walks all the way down to the smallest rendition', async () => {
    const fetchImpl = sizeServer({
      'https://video.twimg.com/high.mp4': 40 * MB,
      'https://video.twimg.com/mid.mp4': 18 * MB,
      'https://video.twimg.com/low.mp4': 4 * MB,
    });

    const result = await selectTelegramVideoVariant(video(), { maxBytes: 10 * MB }, { fetchImpl, logger });

    expect(result.fits).toBe(true);
    if (!result.fits) return;
    expect(result.url).toBe('https://video.twimg.com/low.mp4');
  });

  it('reports a clear reason when nothing fits', async () => {
    const fetchImpl = sizeServer({
      'https://video.twimg.com/high.mp4': 40 * MB,
      'https://video.twimg.com/mid.mp4': 25 * MB,
      'https://video.twimg.com/low.mp4': 14 * MB,
    });

    const result = await selectTelegramVideoVariant(video(), { maxBytes: 10 * MB }, { fetchImpl, logger });

    expect(result.fits).toBe(false);
    if (result.fits) return;
    expect(result.reason).toMatch(/all 3 MP4 variant\(s\).*exceed 10\.0 MB/);
    expect(result.reason).toMatch(/smallest is 14\.0 MB/);
    expect(result.candidates).toHaveLength(3);
  });

  // --- preferred budget with fallback to the original ----------------------

  it('takes a rendition that meets the preferred budget', async () => {
    const fetchImpl = sizeServer({
      'https://video.twimg.com/high.mp4': 24 * MB,
      'https://video.twimg.com/mid.mp4': 7 * MB,
      'https://video.twimg.com/low.mp4': 2 * MB,
    });

    const result = await selectTelegramVideoVariant(
      video(),
      { preferredMaxBytes: 10 * MB, maxBytes: 50 * MB },
      { fetchImpl, logger },
    );

    expect(result.fits).toBe(true);
    if (!result.fits) return;
    expect(result.url).toBe('https://video.twimg.com/mid.mp4');
    expect(result.selectionReason).toMatch(/meets the preferred 10\.0 MB budget/);
  });

  it('keeps the original when nothing meets the preferred budget', async () => {
    // Every rendition is over 10 MB, but the original is within Telegram's 50 MB.
    const fetchImpl = sizeServer({
      'https://video.twimg.com/high.mp4': 34 * MB,
      'https://video.twimg.com/mid.mp4': 22 * MB,
      'https://video.twimg.com/low.mp4': 14 * MB,
    });

    const result = await selectTelegramVideoVariant(
      video(),
      { preferredMaxBytes: 10 * MB, maxBytes: 50 * MB },
      { fetchImpl, logger },
    );

    expect(result.fits).toBe(true);
    if (!result.fits) return;
    expect(result.url).toBe('https://video.twimg.com/high.mp4');
    expect(result.sizeBytes).toBe(34 * MB);
    expect(result.selectionReason).toMatch(/no rendition under the preferred 10\.0 MB/);
    expect(result.selectionReason).toMatch(/keeping the original/);
  });

  it('falls back to the best that fits when even the original is over the hard limit', async () => {
    const fetchImpl = sizeServer({
      'https://video.twimg.com/high.mp4': 60 * MB,
      'https://video.twimg.com/mid.mp4': 22 * MB,
      'https://video.twimg.com/low.mp4': 14 * MB,
    });

    const result = await selectTelegramVideoVariant(
      video(),
      { preferredMaxBytes: 10 * MB, maxBytes: 50 * MB },
      { fetchImpl, logger },
    );

    expect(result.fits).toBe(true);
    if (!result.fits) return;
    expect(result.url).toBe('https://video.twimg.com/mid.mp4');
  });

  it('still rejects when nothing fits even the hard limit', async () => {
    const fetchImpl = sizeServer({
      'https://video.twimg.com/high.mp4': 90 * MB,
      'https://video.twimg.com/mid.mp4': 70 * MB,
      'https://video.twimg.com/low.mp4': 55 * MB,
    });

    const result = await selectTelegramVideoVariant(
      video(),
      { preferredMaxBytes: 10 * MB, maxBytes: 50 * MB },
      { fetchImpl, logger },
    );

    expect(result.fits).toBe(false);
    if (result.fits) return;
    expect(result.reason).toMatch(/smallest is 55\.0 MB/);
  });

  it('prefers the highest-quality rendition that is under the preferred budget', async () => {
    // Two renditions are under 10 MB; the better one must win.
    const fetchImpl = sizeServer({
      'https://video.twimg.com/high.mp4': 24 * MB,
      'https://video.twimg.com/mid.mp4': 9 * MB,
      'https://video.twimg.com/low.mp4': 2 * MB,
    });

    const result = await selectTelegramVideoVariant(
      video(),
      { preferredMaxBytes: 10 * MB, maxBytes: 50 * MB },
      { fetchImpl, logger },
    );

    expect(result.fits).toBe(true);
    if (!result.fits) return;
    expect(result.url).toBe('https://video.twimg.com/mid.mp4');
  });

  it('clamps a preferred budget above the hard limit', async () => {
    const fetchImpl = sizeServer({
      'https://video.twimg.com/high.mp4': 30 * MB,
      'https://video.twimg.com/mid.mp4': 7 * MB,
      'https://video.twimg.com/low.mp4': 2 * MB,
    });

    // preferred 80 MB > hard 10 MB: the hard limit governs.
    const result = await selectTelegramVideoVariant(
      video(),
      { preferredMaxBytes: 80 * MB, maxBytes: 10 * MB },
      { fetchImpl, logger },
    );

    expect(result.fits).toBe(true);
    if (!result.fits) return;
    expect(result.url).toBe('https://video.twimg.com/mid.mp4');
  });

  // --- edge cases ----------------------------------------------------------

  it('handles a single MP4 variant that fits', async () => {
    const only = video({
      mp4Variants: [{ url: 'https://v/only.mp4', bitRate: 900000, contentType: 'video/mp4' }],
    });
    const fetchImpl = sizeServer({ 'https://v/only.mp4': 4 * MB });

    const result = await selectTelegramVideoVariant(only, { maxBytes: 10 * MB }, { fetchImpl, logger });
    expect(result.fits).toBe(true);
  });

  it('handles a single MP4 variant that does not fit', async () => {
    const only = video({
      mp4Variants: [{ url: 'https://v/only.mp4', bitRate: 900000, contentType: 'video/mp4' }],
    });
    const fetchImpl = sizeServer({ 'https://v/only.mp4': 30 * MB });

    const result = await selectTelegramVideoVariant(only, { maxBytes: 10 * MB }, { fetchImpl, logger });
    expect(result.fits).toBe(false);
  });

  it('reports no MP4 variants at all', async () => {
    const result = await selectTelegramVideoVariant(video({ mp4Variants: [] }), { maxBytes: 10 * MB }, {
      fetchImpl: sizeServer({}),
      logger,
    });

    expect(result.fits).toBe(false);
    if (result.fits) return;
    expect(result.reason).toMatch(/no progressive MP4 variant/);
  });

  it('falls back to a bitrate estimate when the CDN reports no size', async () => {
    const fetchImpl = sizeServer({
      'https://video.twimg.com/high.mp4': null,
      'https://video.twimg.com/mid.mp4': null,
      'https://video.twimg.com/low.mp4': null,
    });

    // 2176000 b/s × 46 s ≈ 12.5 MB → too big; 832000 × 46 ≈ 4.8 MB → fits.
    const result = await selectTelegramVideoVariant(video(), { maxBytes: 10 * MB }, { fetchImpl, logger });

    expect(result.fits).toBe(true);
    if (!result.fits) return;
    expect(result.url).toBe('https://video.twimg.com/mid.mp4');
  });

  it('accepts optimistically when size is wholly unknowable', async () => {
    // No content-length and no bitrate/duration to estimate from.
    const unknown = video({
      durationSeconds: undefined,
      mp4Variants: [{ url: 'https://v/x.mp4', contentType: 'video/mp4' }],
    });
    const fetchImpl = sizeServer({ 'https://v/x.mp4': null });

    const result = await selectTelegramVideoVariant(unknown, { maxBytes: 10 * MB }, { fetchImpl, logger });

    expect(result.fits).toBe(true);
    if (!result.fits) return;
    expect(result.selectionReason).toMatch(/size unknown, accepted optimistically/);
  });

  it('orders unsorted variants by bitrate before choosing', async () => {
    const shuffled = video({
      mp4Variants: [
        { url: 'https://video.twimg.com/low.mp4', bitRate: 256000, contentType: 'video/mp4' },
        { url: 'https://video.twimg.com/high.mp4', bitRate: 2176000, contentType: 'video/mp4' },
        { url: 'https://video.twimg.com/mid.mp4', bitRate: 832000, contentType: 'video/mp4' },
      ],
    });
    const fetchImpl = sizeServer({
      'https://video.twimg.com/high.mp4': 5 * MB,
      'https://video.twimg.com/mid.mp4': 3 * MB,
      'https://video.twimg.com/low.mp4': 1 * MB,
    });

    const result = await selectTelegramVideoVariant(shuffled, { maxBytes: 10 * MB }, { fetchImpl, logger });
    expect(result.fits).toBe(true);
    if (!result.fits) return;
    expect(result.url).toBe('https://video.twimg.com/high.mp4');
  });
});

describe('listMp4Variants', () => {
  it('keeps only progressive MP4 and sorts by bitrate descending', () => {
    const media: XMedia = {
      media_key: '7_1',
      type: 'video',
      variants: [
        { bit_rate: 256000, content_type: 'video/mp4', url: 'https://v/low.mp4' },
        { content_type: 'application/x-mpegURL', url: 'https://v/playlist.m3u8' },
        { bit_rate: 2176000, content_type: 'video/mp4', url: 'https://v/high.mp4' },
        { bit_rate: 832000, content_type: 'video/mp4', url: 'https://v/mid.mp4' },
      ],
    };

    const variants = listMp4Variants(media);

    expect(variants.map((v) => v.bitRate)).toEqual([2176000, 832000, 256000]);
    expect(variants.every((v) => !v.url.includes('.m3u8'))).toBe(true);
  });

  it('returns an empty list for an HLS-only video', () => {
    expect(
      listMp4Variants({
        media_key: '7_2',
        type: 'video',
        variants: [{ content_type: 'application/x-mpegURL', url: 'https://v/p.m3u8' }],
      }),
    ).toEqual([]);
  });

  it('returns an empty list when there are no variants', () => {
    expect(listMp4Variants({ media_key: '7_3', type: 'video' })).toEqual([]);
  });

  it('collects the single MP4 an animated GIF is delivered as', () => {
    expect(
      listMp4Variants({
        media_key: '16_1',
        type: 'animated_gif',
        variants: [{ bit_rate: 0, content_type: 'video/mp4', url: 'https://v/g.mp4' }],
      }),
    ).toHaveLength(1);
  });
});
