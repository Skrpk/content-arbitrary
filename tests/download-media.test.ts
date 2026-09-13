import { describe, expect, it, vi } from 'vitest';
import { downloadMedia, formatBytes, toOriginalPhotoUrl } from '@/lib/x/download-media';
import { MediaUnsupportedError } from '@/lib/errors';
import {
  maxUploadBytesFor,
  photoDimensionsAreAcceptable,
  TELEGRAM_MEDIA_GROUP_MAX,
  TELEGRAM_CAPTION_LIMIT,
} from '@/lib/telegram/limits';
import { createTestLogger } from './helpers';
import type { NormalizedMedia } from '@/types';

const photo: NormalizedMedia = {
  mediaKey: '3_1',
  kind: 'photo',
  url: 'https://pbs.twimg.com/media/abc.jpg',
  width: 1200,
  height: 800,
};

const video: NormalizedMedia = {
  mediaKey: '7_1',
  kind: 'video',
  url: 'https://video.twimg.com/ext_tw_video/1/vid/1280x720/abc.mp4',
  contentType: 'video/mp4',
};

function bodyResponse(size: number, contentType: string, withLength = true) {
  return new Response(new Uint8Array(size), {
    status: 200,
    headers: {
      'content-type': contentType,
      ...(withLength ? { 'content-length': String(size) } : {}),
    },
  });
}

describe('documented Telegram limits', () => {
  it('matches the Bot API documentation', () => {
    expect(TELEGRAM_CAPTION_LIMIT).toBe(1024);
    expect(TELEGRAM_MEDIA_GROUP_MAX).toBe(10);
    expect(maxUploadBytesFor('photo', 'multipart')).toBe(10 * 1024 * 1024);
    expect(maxUploadBytesFor('video', 'multipart')).toBe(50 * 1024 * 1024);
    expect(maxUploadBytesFor('photo', 'url')).toBe(5 * 1024 * 1024);
    expect(maxUploadBytesFor('video', 'url')).toBe(20 * 1024 * 1024);
  });
});

describe('photoDimensionsAreAcceptable', () => {
  it('accepts an ordinary photo', () => {
    expect(photoDimensionsAreAcceptable(1200, 800)).toBe(true);
  });

  it('rejects a photo whose dimensions sum above 10000', () => {
    expect(photoDimensionsAreAcceptable(6000, 5000)).toBe(false);
  });

  it('accepts one exactly at the dimension limit', () => {
    expect(photoDimensionsAreAcceptable(5000, 5000)).toBe(true);
  });

  it('rejects an extreme aspect ratio', () => {
    expect(photoDimensionsAreAcceptable(4000, 100)).toBe(false);
  });

  it('accepts a ratio of exactly 20', () => {
    expect(photoDimensionsAreAcceptable(2000, 100)).toBe(true);
  });

  it('defers to Telegram when dimensions are unknown', () => {
    expect(photoDimensionsAreAcceptable(undefined, undefined)).toBe(true);
  });
});

describe('toOriginalPhotoUrl', () => {
  it('requests the original rendition from the X CDN', () => {
    const result = toOriginalPhotoUrl('https://pbs.twimg.com/media/abc.jpg?format=jpg&name=small');
    expect(new URL(result).searchParams.get('name')).toBe('orig');
  });

  it('adds name=orig to a bare .jpg path', () => {
    const result = toOriginalPhotoUrl('https://pbs.twimg.com/media/abc.jpg');
    expect(new URL(result).searchParams.get('name')).toBe('orig');
  });

  it('leaves a non-Twitter host untouched', () => {
    const url = 'https://example.com/image.jpg';
    expect(toOriginalPhotoUrl(url)).toBe(url);
  });

  it('returns a malformed URL unchanged rather than throwing', () => {
    expect(toOriginalPhotoUrl('not a url')).toBe('not a url');
  });
});

describe('downloadMedia', () => {
  const logger = createTestLogger();

  it('downloads a photo and reports its size and type', async () => {
    const fetchImpl = vi.fn(async () => bodyResponse(2048, 'image/jpeg')) as unknown as typeof fetch;

    const result = await downloadMedia(photo, { logger, uploadMode: 'multipart', fetchImpl });

    expect(result.byteLength).toBe(2048);
    expect(result.contentType).toBe('image/jpeg');
    expect(result.filename).toMatch(/\.jpg$/);
  });

  it('rejects an oversized photo from Content-Length without downloading it', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(new Uint8Array(8), {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(11 * 1024 * 1024) },
      }),
    ) as unknown as typeof fetch;

    await expect(
      downloadMedia(photo, { logger, uploadMode: 'multipart', fetchImpl }),
    ).rejects.toBeInstanceOf(MediaUnsupportedError);
  });

  it('rejects an oversized video', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(new Uint8Array(8), {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(60 * 1024 * 1024) },
      }),
    ) as unknown as typeof fetch;

    await expect(
      downloadMedia(video, { logger, uploadMode: 'multipart', fetchImpl }),
    ).rejects.toThrow(/above Telegram's 50\.0 MB limit/);
  });

  it('aborts mid-stream when the server omits Content-Length and overshoots', async () => {
    // A chunked response that would exceed the photo limit if fully buffered.
    const chunk = new Uint8Array(1024 * 1024);
    let emitted = 0;
    let cancelled = false;

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= 20) {
          controller.close();
          return;
        }
        emitted += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });

    const fetchImpl = vi.fn(async () =>
      new Response(stream, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    ) as unknown as typeof fetch;

    await expect(
      downloadMedia(photo, { logger, uploadMode: 'multipart', fetchImpl }),
    ).rejects.toThrow(/exceeds Telegram's 10\.0 MB limit/);

    // The transfer stopped early instead of buffering all 20 MB.
    expect(emitted).toBeLessThan(20);
    expect(cancelled).toBe(true);
  });

  it('treats a 404 on the CDN as permanent', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('gone', { status: 404 }),
    ) as unknown as typeof fetch;

    await expect(
      downloadMedia(photo, { logger, uploadMode: 'multipart', fetchImpl }),
    ).rejects.toMatchObject({ transient: false });
  });

  it('treats a 503 on the CDN as transient', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('busy', { status: 503 }),
    ) as unknown as typeof fetch;

    await expect(
      downloadMedia(photo, { logger, uploadMode: 'multipart', fetchImpl }),
    ).rejects.toMatchObject({ transient: true });
  });

  it('uses the stricter URL-mode limit when that mode is selected', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(new Uint8Array(8), {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(6 * 1024 * 1024) },
      }),
    ) as unknown as typeof fetch;

    // 6 MB passes the 10 MB multipart limit but fails the 5 MB URL limit.
    await expect(
      downloadMedia(photo, { logger, uploadMode: 'url', fetchImpl }),
    ).rejects.toThrow(/5\.0 MB/);
  });

  it('derives a sensible filename for a video', async () => {
    const fetchImpl = vi.fn(async () => bodyResponse(512, 'video/mp4')) as unknown as typeof fetch;

    const result = await downloadMedia(video, { logger, uploadMode: 'multipart', fetchImpl });
    expect(result.filename).toBe('abc.mp4');
  });
});

describe('formatBytes', () => {
  it.each([
    [512, '512 B'],
    [2048, '2.0 KB'],
    [5 * 1024 * 1024, '5.0 MB'],
  ])('formats %i as %s', (input, expected) => {
    expect(formatBytes(input)).toBe(expected);
  });
});
