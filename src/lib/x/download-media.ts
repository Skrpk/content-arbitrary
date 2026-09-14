import { MediaUnsupportedError, XApiError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { maxUploadBytesFor } from '@/lib/telegram/limits';
import type { NormalizedMedia } from '@/types';

/**
 * Downloads an X media asset into memory, ready for a multipart upload to
 * Telegram.
 *
 * Serverless notes:
 *   - nothing is written to disk: the local filesystem does not survive between
 *     invocations, and /tmp buys us nothing for a single-pass upload;
 *   - we refuse oversized assets *before* transferring them where the server
 *     sends a Content-Length, and abort mid-stream otherwise, so a 300 MB video
 *     can never be pulled into a function's memory;
 *   - the hard ceiling is Telegram's own 50 MB upload limit, which comfortably
 *     fits in the default function memory.
 */

export interface DownloadedMedia {
  media: NormalizedMedia;
  bytes: Uint8Array;
  contentType: string;
  filename: string;
  byteLength: number;
}

const DEFAULT_CONTENT_TYPE: Record<'photo' | 'video', string> = {
  photo: 'image/jpeg',
  video: 'video/mp4',
};

function filenameFor(media: NormalizedMedia, contentType: string): string {
  const extensionFromType = contentType.split('/')[1]?.split(';')[0]?.trim();
  const fromUrl = new URL(media.url).pathname.split('/').pop() ?? '';

  if (/\.[A-Za-z0-9]{2,5}$/.test(fromUrl)) return fromUrl;

  const extension = extensionFromType && /^[a-z0-9]{2,5}$/i.test(extensionFromType)
    ? extensionFromType
    : media.kind === 'photo'
      ? 'jpg'
      : 'mp4';

  return `${media.mediaKey}.${extension}`;
}

/**
 * X photo URLs accept a `name` parameter selecting the rendition. `orig` is the
 * original upload — the whole point of this application is to republish the
 * source quality, so that is what we ask for.
 */
export function toOriginalPhotoUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)twimg\.com$/i.test(parsed.hostname)) return url;
    if (!parsed.searchParams.has('format') && !/\.(jpg|jpeg|png|webp)$/i.test(parsed.pathname)) {
      return url;
    }
    parsed.searchParams.set('name', 'orig');
    return parsed.toString();
  } catch {
    return url;
  }
}

export async function downloadMedia(
  media: NormalizedMedia,
  options: {
    logger: Logger;
    uploadMode: 'multipart' | 'url';
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    /** Caps the transfer below Telegram's own limit; never above it. */
    maxBytes?: number;
  },
): Promise<DownloadedMedia> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const telegramMax = maxUploadBytesFor(media.kind, options.uploadMode);
  const maxBytes =
    options.maxBytes === undefined ? telegramMax : Math.min(options.maxBytes, telegramMax);
  const url = media.kind === 'photo' ? toOriginalPhotoUrl(media.url) : media.url;

  options.logger.info('media.download_start', {
    mediaKey: media.mediaKey,
    kind: media.kind,
    maxBytes,
  });

  const response = await fetchImpl(url, {
    headers: { 'user-agent': 'content-arbitrary/1.0' },
    signal: options.signal,
    cache: 'no-store',
  });

  if (!response.ok) {
    // 404/403 on a CDN asset will not fix itself; anything else might.
    const transient = response.status >= 500 || response.status === 429;
    throw new XApiError(`Failed to download media ${media.mediaKey} (HTTP ${response.status})`, {
      transient,
      code: `media_http_${response.status}`,
      status: response.status,
    });
  }

  const declaredLength = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new MediaUnsupportedError(
      `Media ${media.mediaKey} is ${formatBytes(declaredLength)}, above Telegram's ` +
        `${formatBytes(maxBytes)} limit for ${media.kind} via ${options.uploadMode}`,
      'media_too_large',
    );
  }

  const contentType =
    response.headers.get('content-type')?.split(';')[0]?.trim() || DEFAULT_CONTENT_TYPE[media.kind];

  const bytes = await readWithLimit(response, maxBytes, media.mediaKey, media.kind, options.uploadMode);

  options.logger.info('media.download_complete', {
    mediaKey: media.mediaKey,
    kind: media.kind,
    byteLength: bytes.byteLength,
    contentType,
  });

  return {
    media,
    bytes,
    contentType,
    filename: filenameFor(media, contentType),
    byteLength: bytes.byteLength,
  };
}

/**
 * Read the body chunk by chunk, aborting the moment the running total exceeds
 * what Telegram would accept. A server that omits Content-Length can therefore
 * still never make us buffer an unbounded amount.
 */
async function readWithLimit(
  response: Response,
  maxBytes: number,
  mediaKey: string,
  kind: 'photo' | 'video',
  uploadMode: string,
): Promise<Uint8Array> {
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new MediaUnsupportedError(
        `Media ${mediaKey} is ${formatBytes(buffer.byteLength)}, above Telegram's ` +
          `${formatBytes(maxBytes)} limit for ${kind} via ${uploadMode}`,
        'media_too_large',
      );
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new MediaUnsupportedError(
          `Media ${mediaKey} exceeds Telegram's ${formatBytes(maxBytes)} limit for ` +
            `${kind} via ${uploadMode} (aborted after ${formatBytes(total)})`,
          'media_too_large',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
