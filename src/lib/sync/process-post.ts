import { getEnv, type Env } from '@/lib/env';
import { describeError, MediaUnsupportedError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import type { TelegramClient } from '@/lib/telegram/client';
import { formatCaption, formatTextPost } from '@/lib/telegram/format-caption';
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
import { acquireMedia, chosenMediaOf } from '@/lib/sync/acquire-media';
import type { NormalizedMedia, NormalizedPost, TelegramMethod } from '@/types';
import { reviewLinks, sendForApproval } from '@/lib/sync/approval';
import { formatSourceLabel } from '@/lib/sources/display';
import type { ApprovalPayload } from '@/db/schema';
import type { PostFooter } from '@/lib/telegram/post-footer';
import { defaultSleep } from '@/lib/sync/retry';
import type { TelegramDestination } from '@/lib/workspace';

export interface ProcessOutcome {
  status: 'published' | 'failed' | 'skipped' | 'dry-run' | 'awaiting-approval';
  method: TelegramMethod;
  mediaCount: number;
  caption: string;
  messages: { messageId: number; mediaIndex: number | null; kind: string }[];
  primaryMessageId: number | null;
  error?: string;
  permanent?: boolean;
  /**
   * Set when the post went to the reviewer instead of the channel: to their
   * chat, with the message holding its buttons, or — `queued` — into the
   * review queue, with no message at all.
   */
  approval?:
    | { queued?: false; payload: ApprovalPayload; adminChatId: string; adminMessageId: number }
    | { queued: true; payload: ApprovalPayload };
}

/** What the send already holds of the post's media, for the pre-review hook to reuse. */
export interface ReviewMedia {
  /** The first item's bytes, when it is a photo downloaded for the send. */
  firstPhotoBytes?: Uint8Array;
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
    /** Database id of the row, needed to address the approval buttons. */
    postId?: number;
    /**
     * Where this post goes. Passed in rather than read from the environment,
     * because the channel and the reviewer belong to the tenant that owns the
     * source, not to the installation.
     */
    destination: TelegramDestination;
    /**
     * The source mirrors posts without media, as text. Without it such a post
     * is skipped, as it always was.
     */
    textOnly?: boolean;
    /**
     * Run just before the post is sent for review — Shadow Radar's moment to
     * score it, ahead of any decision. It is handed the first photo's bytes
     * when they were already downloaded for the send, so nothing fetches them
     * twice. What it returns is shown under the link on the review message.
     * It must not throw; if it does anyway, the post still goes to review,
     * without a note.
     */
    beforeReview?: (media: ReviewMedia) => Promise<string | null | void>;
    /**
     * The post's text in the channel's language, or null to keep it as it is.
     * Asked only for a post about to be sent — alongside beforeReview — and it
     * must not throw; if it does anyway, the original text is sent.
     */
    translate?: (text: string) => Promise<string | null>;
    /** The workspace's footer, added under every post. */
    footer?: PostFooter | null;
    /**
     * Under review, collect the post in the review queue instead of sending it
     * to the reviewer's chat: it is checked, scored and translated just the
     * same, but nothing is sent until it is decided on the queue page.
     */
    queueForReview?: boolean;
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
  const captionFor = (text: string) =>
    formatCaption({
      text,
      username: post.authorUsername,
      postId: post.id,
      ...sourceFraming(post, env),
      prefix: env.CAPTION_PREFIX,
      suffix: env.CAPTION_SUFFIX,
      footer: options.footer,
    });
  let { caption, overflowMessage } = captionFor(post.text);

  if (method === 'none' && options.textOnly && post.text !== '') {
    return processTextPost(post, { ...options, env, logger });
  }

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
    logDryRun(logger, post, media, method, caption, overflowMessage, env.REQUIRE_APPROVAL);
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
  let payloads: MediaPayload[];

  try {
    payloads = await acquireMedia(media, { env, logger, fetchImpl: options.fetchImpl });
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

  // --- Phase 2: review, or publish straight to the channel. ------------------

  /**
   * With REQUIRE_APPROVAL the post goes to the reviewer's private chat instead
   * of the channel. Telegram hands back a file_id for each asset, which is
   * stored so that approval can re-send without downloading from X again.
   */
  if (env.REQUIRE_APPROVAL) {
    // destinationFor refuses a tenant with approval on and no reviewer, so by
    // the time a post reaches here the admin chat is known to exist.
    const reviewContext: SendContext = {
      client: options.client,
      chatId: options.destination.adminChatId!,
      disableNotification: false,
    };

    // Scored on the original, translated meanwhile: neither waits for the other.
    const [translated, radarNote] = await Promise.all([
      translateText(options.translate, post.text, logger),
      runBeforeReview(options.beforeReview, logger, {
        firstPhotoBytes:
          media[0]?.kind === 'photo' && payloads[0]?.mode === 'multipart' ? payloads[0].downloaded.bytes : undefined,
      }),
    ]);
    if (translated) ({ caption, overflowMessage } = captionFor(translated));

    if (options.queueForReview) {
      logger.info('approval.queued', { xPostId: post.id, method, mediaCount: payloads.length });
      return {
        status: 'awaiting-approval',
        method,
        mediaCount: media.length,
        caption,
        messages: [],
        primaryMessageId: null,
        approval: {
          queued: true,
          payload: {
            method: method as 'sendPhoto' | 'sendVideo' | 'sendMediaGroup',
            caption,
            overflowMessage,
            items: [],
            sourceMedia: chosenMediaOf(payloads),
          },
        },
      };
    }

    logger.info('approval.review_send_start', {
      xPostId: post.id,
      method,
      mediaCount: payloads.length,
    });

    try {
      const review = await sendForApproval(
        reviewContext,
        {
          postId: options.postId!,
          xPostUrl: post.url,
          sourceLabel: formatSourceLabel(post.platform ?? 'x', post.authorUsername),
          method: method as 'sendPhoto' | 'sendVideo' | 'sendMediaGroup',
          caption,
          overflowMessage,
          payloads,
          ...reviewLinks(env.APP_BASE_URL, options.postId!),
          channelLabel: options.destination.channelLabel,
          radarNote,
        },
        { logger, sleep },
      );

      logger.info('approval.awaiting_decision', {
        xPostId: post.id,
        adminMessageId: review.adminMessageId,
        capturedFileIds: review.payload.items.length,
      });

      return {
        status: 'awaiting-approval',
        method,
        mediaCount: media.length,
        caption,
        messages: [],
        primaryMessageId: null,
        approval: review,
      };
    } catch (error) {
      const permanent = isPermanentTelegramError(error);
      logger.error('approval.review_send_failed', {
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
  }

  const translated = await translateText(options.translate, post.text, logger);
  if (translated) ({ caption, overflowMessage } = captionFor(translated));

  const context: SendContext = {
    client: options.client,
    chatId: options.destination.chatId,
    disableNotification: options.destination.disableNotification,
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

      // Already escaped and within the message limit — and it may carry the
      // footer's link, which re-escaping would turn into visible markup.
      const followUp = await sendText(context, overflowMessage, {
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

/**
 * Publish, or send for review, a post with no media as a text message.
 *
 * The same three outcomes as a media post — dry run, review, channel — minus
 * everything about media. It is one message, so there is no overflow and no
 * risk of a half-published album.
 */
async function processTextPost(
  post: NormalizedPost,
  options: {
    client: TelegramClient;
    logger: Logger;
    env: Env;
    sleep?: (ms: number) => Promise<void>;
    postId?: number;
    destination: TelegramDestination;
    beforeReview?: (media: ReviewMedia) => Promise<string | null | void>;
    translate?: (text: string) => Promise<string | null>;
    footer?: PostFooter | null;
    queueForReview?: boolean;
  },
): Promise<ProcessOutcome> {
  const { env, logger } = options;
  const method: TelegramMethod = 'sendMessage';
  const textFor = (body: string) =>
    formatTextPost({
      text: body,
      username: post.authorUsername,
      postId: post.id,
      ...sourceFraming(post, env),
      prefix: env.CAPTION_PREFIX,
      suffix: env.CAPTION_SUFFIX,
      footer: options.footer,
    });
  let text = textFor(post.text);

  const base = { method, mediaCount: 0, caption: text, primaryMessageId: null };

  if (env.DRY_RUN) {
    logDryRun(logger, post, [], method, text, undefined, env.REQUIRE_APPROVAL);
    return { ...base, status: 'dry-run', messages: [] };
  }

  try {
    if (env.REQUIRE_APPROVAL) {
      const [translated, radarNote] = await Promise.all([
        translateText(options.translate, post.text, logger),
        runBeforeReview(options.beforeReview, logger, {}),
      ]);
      if (translated) base.caption = text = textFor(translated);

      if (options.queueForReview) {
        logger.info('approval.queued', { xPostId: post.id, method, textOnly: true });
        const linkPreviewUrl = linkPreviewOf(post);
        return {
          ...base,
          status: 'awaiting-approval',
          messages: [],
          approval: {
            queued: true,
            payload: { method, caption: text, items: [], ...(linkPreviewUrl ? { linkPreviewUrl } : {}) },
          },
        };
      }

      const review = await sendForApproval(
        {
          client: options.client,
          chatId: options.destination.adminChatId!,
          disableNotification: false,
        },
        {
          postId: options.postId!,
          xPostUrl: post.url,
          sourceLabel: formatSourceLabel(post.platform ?? 'x', post.authorUsername),
          method,
          caption: text,
          payloads: [],
          ...reviewLinks(env.APP_BASE_URL, options.postId!),
          channelLabel: options.destination.channelLabel,
          radarNote,
          linkPreviewUrl: linkPreviewOf(post),
        },
        { logger, sleep: options.sleep },
      );

      logger.info('approval.awaiting_decision', {
        xPostId: post.id,
        adminMessageId: review.adminMessageId,
        textOnly: true,
      });
      return { ...base, status: 'awaiting-approval', messages: [], approval: review };
    }

    const translated = await translateText(options.translate, post.text, logger);
    if (translated) base.caption = text = textFor(translated);

    const sent = await sendText(
      {
        client: options.client,
        chatId: options.destination.chatId,
        disableNotification: options.destination.disableNotification,
      },
      text,
      { linkPreviewUrl: linkPreviewOf(post) },
    );

    logger.info('telegram.published', { xPostId: post.id, method, telegramMessageIds: [sent.message_id] });
    return {
      ...base,
      status: 'published',
      messages: [{ messageId: sent.message_id, mediaIndex: null, kind: 'text' }],
      primaryMessageId: sent.message_id,
    };
  } catch (error) {
    const permanent = isPermanentTelegramError(error);
    logger.error(env.REQUIRE_APPROVAL ? 'approval.review_send_failed' : 'telegram.upload_failed', {
      xPostId: post.id,
      method,
      permanent,
      error: describeError(error),
    });
    return {
      ...base,
      status: permanent ? 'skipped' : 'failed',
      messages: [],
      error: describeError(error),
      permanent,
    };
  }
}

/**
 * How a post names its source in its own text. A feed entry ends with its
 * article's link — a summary without it would leave readers nowhere to go —
 * and the preview card Telegram draws for it is the post's picture. An X post
 * follows sourceLineInPost.
 */
function sourceFraming(post: NormalizedPost, env: Env): { includeSourceLink: boolean; sourceLine?: string } {
  if (post.platform === 'rss') return post.url ? { includeSourceLink: true, sourceLine: post.url } : { includeSourceLink: false };
  return { includeSourceLink: sourceLineInPost(env) };
}

/** The link a feed entry's text message previews; none for X, whose previews stay off. */
function linkPreviewOf(post: NormalizedPost): string | undefined {
  return post.platform === 'rss' && post.url ? post.url : undefined;
}

/**
 * Whether the post itself ends with the "Source:" line. Under review it does
 * not: the message with the buttons already carries the link to the original,
 * so the post the reviewer approves — and the channel reads — is clean of it.
 */
function sourceLineInPost(env: Env): boolean {
  return env.INCLUDE_SOURCE_LINK && !env.REQUIRE_APPROVAL;
}

function isPermanentTelegramError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'transient' in error &&
    (error as { transient: unknown }).transient === false
  );
}

/** The translated text, or null to keep the original — whatever goes wrong. */
async function translateText(
  translate: ((text: string) => Promise<string | null>) | undefined,
  text: string,
  logger: Logger,
): Promise<string | null> {
  if (!translate || text.trim() === '') return null;
  try {
    return await translate(text);
  } catch (error) {
    logger.warn('translation.failed', { error: describeError(error) });
    return null;
  }
}

/** Run the pre-review hook; its note for the review message, or null — whatever goes wrong. */
async function runBeforeReview(
  hook: ((media: ReviewMedia) => Promise<string | null | void>) | undefined,
  logger: Logger,
  media: ReviewMedia,
): Promise<string | null> {
  if (!hook) return null;
  try {
    return (await hook(media)) ?? null;
  } catch (error) {
    logger.error('approval.before_review_failed', { error: describeError(error) });
    return null;
  }
}

function logDryRun(
  logger: Logger,
  post: NormalizedPost,
  media: NormalizedMedia[],
  method: TelegramMethod,
  caption: string,
  overflowMessage?: string,
  requireApproval = false,
) {
  const photos = media.filter((item) => item.kind === 'photo').length;
  const videos = media.filter((item) => item.kind === 'video').length;
  const description = [
    photos > 0 ? `${photos} photo${photos === 1 ? '' : 's'}` : null,
    videos > 0 ? `${videos} video${videos === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' + ') || 'none (text only)';

  logger.info('dry_run.post', {
    dryRun: true,
    xPostId: post.id,
    xPostUrl: post.url,
    media: description,
    telegramMethod: method,
    caption,
    captionLength: caption.length,
    hasOverflowMessage: Boolean(overflowMessage),
    destination: requireApproval ? 'admin review' : 'channel',
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
      `Destination: ${requireApproval ? 'admin review' : 'channel'}`,
      `Caption: ${JSON.stringify(caption)}`,
      `Would publish: true`,
    ].join('\n'),
  );
}
