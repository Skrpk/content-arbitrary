import type { Env } from '@/lib/env';
import { MediaUnsupportedError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { maxUploadBytesFor } from '@/lib/telegram/limits';
import type { MediaPayload } from '@/lib/telegram/send-media';
import { downloadMedia, formatBytes } from '@/lib/x/download-media';
import { selectTelegramVideoVariant } from '@/lib/x/select-video-variant';
import type { NormalizedMedia } from '@/types';

/**
 * Every asset of a post, ready for the Bot API — or an error, before anything
 * is sent.
 *
 * All or nothing: a post either reaches Telegram complete or not at all, so a
 * failure here leaves no half-published album behind. Throws
 * MediaUnsupportedError for what no retry will fix (a video too large in every
 * rendition, a file Telegram would refuse) and anything else for what one
 * might.
 *
 * The same path for a post sent the moment it is seen and for a queued post
 * published later from its stored media, so the two cannot drift apart on
 * what they send.
 */
export async function acquireMedia(
  media: NormalizedMedia[],
  options: { env: Env; logger: Logger; fetchImpl?: typeof fetch },
): Promise<MediaPayload[]> {
  const { env, logger } = options;
  const payloads: MediaPayload[] = [];

  for (const item of media) {
    /**
     * X encodes each video at several bitrates. Rather than always taking the
     * largest and failing when it is over the limit, pick the best rendition
     * that actually fits — no transcoding required.
     */
    let asset = item;

    if (item.kind === 'video' && (item.mp4Variants?.length ?? 0) > 1) {
      const maxBytes = Math.min(
        env.MAX_VIDEO_SIZE_MB * 1024 * 1024,
        maxUploadBytesFor('video', env.MEDIA_UPLOAD_MODE),
      );

      const selection = await selectTelegramVideoVariant(
        item,
        {
          maxBytes,
          preferredMaxBytes:
            env.PREFERRED_VIDEO_SIZE_MB === undefined ? undefined : env.PREFERRED_VIDEO_SIZE_MB * 1024 * 1024,
        },
        { fetchImpl: options.fetchImpl, logger },
      );

      if (!selection.fits) {
        throw new MediaUnsupportedError(selection.reason, 'media_too_large');
      }

      if (selection.url !== item.url) {
        logger.info('video.variant_downgraded', {
          mediaKey: item.mediaKey,
          fromBitRate: item.bitRate,
          toBitRate: selection.bitRate,
          sizeBytes: selection.sizeBytes,
          budget: formatBytes(maxBytes),
          reason: selection.selectionReason,
        });
      }

      asset = {
        ...item,
        url: selection.url,
        bitRate: selection.bitRate,
        contentType: selection.contentType,
      };
    }

    if (env.MEDIA_UPLOAD_MODE === 'url') {
      payloads.push({ mode: 'url', media: asset });
      continue;
    }

    const downloaded = await downloadMedia(asset, {
      logger,
      uploadMode: env.MEDIA_UPLOAD_MODE,
      fetchImpl: options.fetchImpl,
      maxBytes: asset.kind === 'video' ? env.MAX_VIDEO_SIZE_MB * 1024 * 1024 : undefined,
    });
    payloads.push({ mode: 'multipart', downloaded });
  }

  return payloads;
}

/** The asset each payload carries, as it was chosen: what a queued post stores to fetch again. */
export function chosenMediaOf(payloads: MediaPayload[]): NormalizedMedia[] {
  return payloads.map((payload) => (payload.mode === 'multipart' ? payload.downloaded.media : payload.media));
}
