import { getEnv, type Env } from '@/lib/env';
import { describeError, MediaUnsupportedError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import type { TelegramClient } from '@/lib/telegram/client';
import { formatCaption, formatMessageText } from '@/lib/telegram/format-caption';
import {
  photoDimensionsAreAcceptable,
  TELEGRAM_MEDIA_GROUP_MAX,
  TELEGRAM_MIN_DELAY_BETWEEN_SENDS_MS,
} from '@/lib/telegram/limits';
import {
  sendMediaGroup,
  sendPhoto,
  sendText,
  sendVideo,
  type MediaPayload,
  type SendContext,
} from '@/lib/telegram/send-media';
import { downloadMedia, formatBytes, type DownloadedMedia } from '@/lib/x/download-media';
import { selectTelegramVideoVariant } from '@/lib/x/select-video-variant';
import { maxUploadBytesFor } from '@/lib/telegram/limits';
import type { NormalizedMedia, NormalizedPost, TelegramMethod } from '@/types';
import { defaultSleep } from '@/lib/sync/retry';

export interface ProcessOutcome {
  status: 'published' | 'failed' | 'skipped' | 'dry-run';
  method: TelegramMethod;
  mediaCount: number;
  caption: string;
  messages: { messageId: number; mediaIndex: number | null; kind: string }[];
  primaryMessageId: number | null;
  error?: string;
  permanent?: boolean;
}

/** Which Bot API method fits this set of media. */
export function chooseMethod(media: NormalizedMedia[]): TelegramMethod {
  if (media.length === 0) return 'none';
  if (media.length === 1) return media[0]!.kind === 'video' ? 'sendVideo' : 'sendPhoto';
  return 'sendMediaGroup';
}

/**
 * Publish one X post to Telegram.
 *
 * Media policy is all-or-nothing: every asset is downloaded and validated
 * *before* the first Bot API send. A post therefore either appears in the
 * channel complete, or does not appear at all and is recorded with a reason.
 * The alternative — uploading as we go — can leave a half-published album in
 * the channel that no retry can tidy up.
 */
export async function processPost(
  post: NormalizedPost,
  options: {
    client: TelegramClient;
    logger: Logger;
    env?: Env;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<ProcessOutcome> {
  const env = options.env ?? getEnv();
  const logger = options.logger;
  const sleep = options.sleep ?? defaultSleep;

  // Telegram albums hold at most 10 items. X currently allows at most 4, but
  // clamping here means a future change upstream degrades gracefully instead of
  // failing the whole post.
  const media = post.media.slice(0, TELEGRAM_MEDIA_GROUP_MAX);
  if (post.media.length > media.length) {
    logger.warn('post.media_truncated', {
      xPostId: post.id,
      total: post.media.length,
      kept: media.length,
      limit: TELEGRAM_MEDIA_GROUP_MAX,
    });
  }

  const method = chooseMethod(media);
  const { caption, overflowMessage } = formatCaption({
    text: post.text,
    username: post.authorUsername,
    postId: post.id,
    includeSourceLink: env.INCLUDE_SOURCE_LINK,
    prefix: env.CAPTION_PREFIX,
    suffix: env.CAPTION_SUFFIX,
  });

  if (method === 'none') {
    return {
      status: 'skipped',
      method,
      mediaCount: 0,
      caption,
      messages: [],
      primaryMessageId: null,
      error: 'post has no usable media',
      permanent: true,
    };
  }

  // Cheap local rejection: X gives us the dimensions, so a photo Telegram would
  // certainly refuse becomes a `skipped` without spending an upload.
  for (const item of media) {
    if (item.kind === 'photo' && !photoDimensionsAreAcceptable(item.width, item.height)) {
      return {
        status: 'skipped',
        method,
        mediaCount: media.length,
        caption,
        messages: [],
        primaryMessageId: null,
        error:
          `photo ${item.mediaKey} is ${item.width}x${item.height}, outside Telegram's ` +
          'limits (width + height must be <= 10000, ratio <= 20)',
        permanent: true,
      };
    }
  }

  if (env.DRY_RUN) {
    logDryRun(logger, post, media, method, caption, overflowMessage);
    return {
      status: 'dry-run',
      method,
      mediaCount: media.length,
      caption,
      messages: [],
      primaryMessageId: null,
    };
  }

  // --- Phase 1: acquire every asset before publishing anything. -------------
  const payloads: MediaPayload[] = [];

  try {
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
              env.PREFERRED_VIDEO_SIZE_MB === undefined
                ? undefined
                : env.PREFERRED_VIDEO_SIZE_MB * 1024 * 1024,
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

      const downloaded: DownloadedMedia = await downloadMedia(asset, {
        logger,
        uploadMode: env.MEDIA_UPLOAD_MODE,
        fetchImpl: options.fetchImpl,
        maxBytes:
          asset.kind === 'video' ? env.MAX_VIDEO_SIZE_MB * 1024 * 1024 : undefined,
      });
      payloads.push({ mode: 'multipart', downloaded });
    }
  } catch (error) {
    const permanent = error instanceof MediaUnsupportedError;
    logger.error('post.media_failed', {
      xPostId: post.id,
      permanent,
      error: describeError(error),
    });
    return {
      status: permanent ? 'skipped' : 'failed',
      method,
      mediaCount: media.length,
      caption,
      messages: [],
      primaryMessageId: null,
      error: describeError(error),
      permanent,
    };
  }

  // --- Phase 2: publish. ----------------------------------------------------
  const context: SendContext = {
    client: options.client,
    chatId: env.TELEGRAM_CHAT_ID,
    disableNotification: env.TELEGRAM_DISABLE_NOTIFICATION,
  };

  logger.info('telegram.upload_start', {
    xPostId: post.id,
    method,
    mediaCount: payloads.length,
    uploadMode: env.MEDIA_UPLOAD_MODE,
  });

  const messages: ProcessOutcome['messages'] = [];

  try {
    if (method === 'sendMediaGroup') {
      const sent = await sendMediaGroup(context, payloads, caption);
      sent.forEach((message, index) => {
        messages.push({ messageId: message.message_id, mediaIndex: index, kind: 'media' });
      });
    } else {
      const single = payloads[0]!;
      const sent =
        method === 'sendVideo'
          ? await sendVideo(context, single, caption)
          : await sendPhoto(context, single, caption);
      messages.push({ messageId: sent.message_id, mediaIndex: 0, kind: 'media' });
    }
  } catch (error) {
    const permanent = error instanceof MediaUnsupportedError || isPermanentTelegramError(error);
    logger.error('telegram.upload_failed', {
      xPostId: post.id,
      method,
      permanent,
      error: describeError(error),
    });
    return {
      status: permanent ? 'skipped' : 'failed',
      method,
      mediaCount: media.length,
      caption,
      messages: [],
      primaryMessageId: null,
      error: describeError(error),
      permanent,
    };
  }

  const primaryMessageId = messages[0]?.messageId ?? null;

  logger.info('telegram.published', {
    xPostId: post.id,
    method,
    telegramMessageIds: messages.map((message) => message.messageId),
  });

  // --- Phase 3: the overflow text, if the post was too long for a caption. ---
  if (overflowMessage) {
    try {
      // Pace ourselves: the Bot FAQ asks for no more than one message per second
      // in a single chat, and we have just sent an album.
      await sleep(TELEGRAM_MIN_DELAY_BETWEEN_SENDS_MS);

      const followUp = await sendText(context, formatMessageText(stripHtml(overflowMessage)), {
        replyToMessageId: primaryMessageId ?? undefined,
      });
      messages.push({ messageId: followUp.message_id, mediaIndex: null, kind: 'text' });

      logger.info('telegram.overflow_text_sent', {
        xPostId: post.id,
        telegramMessageId: followUp.message_id,
      });
    } catch (error) {
      // The media is already in the channel, which is the valuable part. Losing
      // the tail of a long caption must not mark the post failed and cause a
      // retry that would duplicate the album.
      logger.warn('telegram.overflow_text_failed', {
        xPostId: post.id,
        error: describeError(error),
      });
    }
  }

  return {
    status: 'published',
    method,
    mediaCount: media.length,
    caption,
    messages,
    primaryMessageId,
  };
}

function isPermanentTelegramError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'transient' in error &&
    (error as { transient: unknown }).transient === false
  );
}

/** The overflow message is re-escaped by formatMessageText, so unescape first. */
function stripHtml(html: string): string {
  return html.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function logDryRun(
  logger: Logger,
  post: NormalizedPost,
  media: NormalizedMedia[],
  method: TelegramMethod,
  caption: string,
  overflowMessage?: string,
) {
  const photos = media.filter((item) => item.kind === 'photo').length;
  const videos = media.filter((item) => item.kind === 'video').length;
  const description = [
    photos > 0 ? `${photos} photo${photos === 1 ? '' : 's'}` : null,
    videos > 0 ? `${videos} video${videos === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' + ');

  logger.info('dry_run.post', {
    dryRun: true,
    xPostId: post.id,
    xPostUrl: post.url,
    media: description,
    telegramMethod: method,
    caption,
    captionLength: caption.length,
    hasOverflowMessage: Boolean(overflowMessage),
    wouldPublish: true,
  });

  // A human-readable mirror of the same information, matching the format in the
  // README so the log is easy to eyeball during setup.
  console.log(
    [
      'DRY RUN:',
      `X Post: ${post.id}`,
      `Media: ${description}`,
      `Telegram method: ${method}`,
      `Caption: ${JSON.stringify(caption)}`,
      `Would publish: true`,
    ].join('\n'),
  );
}
