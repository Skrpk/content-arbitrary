import type { ApprovalMediaItem, ApprovalPayload } from '@/db/schema';
import type { Logger } from '@/lib/logger';
import { mediaFileIdOf, type TelegramMessage } from '@/lib/telegram/client';
import { formatMessageText } from '@/lib/telegram/format-caption';
import { TELEGRAM_MIN_DELAY_BETWEEN_SENDS_MS } from '@/lib/telegram/limits';
import {
  sendMediaGroup,
  sendPhoto,
  sendText,
  sendVideo,
  type InlineKeyboardMarkup,
  type MediaPayload,
  type SendContext,
} from '@/lib/telegram/send-media';
import { defaultSleep } from '@/lib/sync/retry';
import type { TelegramMethod } from '@/types';

/**
 * Review workflow.
 *
 * A post is first delivered to the reviewer's private chat with the bot,
 * carrying Approve / Reject buttons. Only on Approve does it reach the channel.
 *
 * The review send is not wasted work: Telegram returns a `file_id` for every
 * asset it stored, and re-sending by `file_id` needs no upload and no download.
 * Publishing an approved post therefore costs one cheap API call and never
 * touches the X CDN again — so an approval hours later still works, even though
 * X media URLs may have rotated by then.
 */

export type ApprovalAction = 'approve' | 'reject';

/** Telegram caps callback_data at 64 bytes, so keep it to a verb and an id. */
export function buildCallbackData(action: ApprovalAction, postId: number): string {
  return `${action === 'approve' ? 'ap' : 'rj'}:${postId}`;
}

export function parseCallbackData(
  data: string | undefined,
): { action: ApprovalAction; postId: number } | null {
  if (!data) return null;

  const match = /^(ap|rj):(\d{1,12})$/.exec(data.trim());
  if (!match) return null;

  const postId = Number(match[2]);
  if (!Number.isSafeInteger(postId) || postId <= 0) return null;

  return { action: match[1] === 'ap' ? 'approve' : 'reject', postId };
}

export function buildApprovalKeyboard(postId: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: buildCallbackData('approve', postId) },
        { text: '🚫 Reject', callback_data: buildCallbackData('reject', postId) },
      ],
    ],
  };
}

/** Turns the messages Telegram just returned into re-sendable references. */
function collectMediaItems(
  messages: TelegramMessage[],
  payloads: MediaPayload[],
): ApprovalMediaItem[] {
  const items: ApprovalMediaItem[] = [];

  messages.forEach((message, index) => {
    const fileId = mediaFileIdOf(message);
    if (!fileId) return;

    const source = payloads[index];
    const media = source
      ? source.mode === 'multipart'
        ? source.downloaded.media
        : source.media
      : undefined;

    items.push({
      kind: media?.kind ?? (message.video ? 'video' : 'photo'),
      fileId,
      width: media?.width,
      height: media?.height,
      durationSeconds: media?.durationSeconds,
    });
  });

  return items;
}

export interface ReviewRequest {
  postId: number;
  xPostUrl: string;
  method: Exclude<TelegramMethod, 'sendMessage' | 'none'>;
  caption: string;
  overflowMessage?: string;
  payloads: MediaPayload[];
}

export interface ReviewResult {
  adminChatId: string;
  /** The message carrying the buttons — the one to strip after a decision. */
  adminMessageId: number;
  payload: ApprovalPayload;
}

/**
 * Deliver a post to the reviewer.
 *
 * Albums cannot carry an inline keyboard, so for `sendMediaGroup` the buttons
 * go on a short follow-up message instead. Either way `adminMessageId` is
 * whichever message actually holds them.
 */
export async function sendForApproval(
  context: SendContext,
  request: ReviewRequest,
  options?: { logger?: Logger; sleep?: (ms: number) => Promise<void> },
): Promise<ReviewResult> {
  const sleep = options?.sleep ?? defaultSleep;
  const keyboard = buildApprovalKeyboard(request.postId);

  let buttonMessageId: number;
  let mediaMessages: TelegramMessage[];

  if (request.method === 'sendMediaGroup') {
    mediaMessages = await sendMediaGroup(
      { ...context, replyMarkup: undefined },
      request.payloads,
      request.caption,
    );

    await sleep(TELEGRAM_MIN_DELAY_BETWEEN_SENDS_MS);

    const control = await sendText(
      { ...context, replyMarkup: keyboard },
      formatMessageText(`Review album (${request.payloads.length} items)\n${request.xPostUrl}`),
      { replyToMessageId: mediaMessages[0]?.message_id },
    );
    buttonMessageId = control.message_id;
  } else {
    const single = request.payloads[0]!;
    const sent =
      request.method === 'sendVideo'
        ? await sendVideo({ ...context, replyMarkup: keyboard }, single, request.caption)
        : await sendPhoto({ ...context, replyMarkup: keyboard }, single, request.caption);

    mediaMessages = [sent];
    buttonMessageId = sent.message_id;
  }

  const items = collectMediaItems(mediaMessages, request.payloads);

  if (items.length !== request.payloads.length) {
    options?.logger?.warn('approval.file_id_missing', {
      expected: request.payloads.length,
      captured: items.length,
    });
  }

  return {
    adminChatId: context.chatId,
    adminMessageId: buttonMessageId,
    payload: {
      method: request.method,
      caption: request.caption,
      overflowMessage: request.overflowMessage,
      items,
    },
  };
}

export interface PublishResult {
  messages: { messageId: number; mediaIndex: number | null; kind: string }[];
  primaryMessageId: number | null;
  method: TelegramMethod;
}

/**
 * Send an approved post to the channel, re-using the stored `file_id`s.
 *
 * No download, no upload — Telegram already holds the bytes.
 */
export async function publishApprovedPayload(
  context: SendContext,
  payload: ApprovalPayload,
  options?: { logger?: Logger; sleep?: (ms: number) => Promise<void> },
): Promise<PublishResult> {
  const sleep = options?.sleep ?? defaultSleep;

  const payloads: MediaPayload[] = payload.items.map((item) => ({
    mode: 'file_id',
    fileId: item.fileId,
    media: {
      mediaKey: item.fileId,
      kind: item.kind,
      url: item.fileId,
      width: item.width,
      height: item.height,
      durationSeconds: item.durationSeconds,
    },
  }));

  const messages: PublishResult['messages'] = [];

  if (payload.method === 'sendMediaGroup') {
    const sent = await sendMediaGroup(context, payloads, payload.caption);
    sent.forEach((message, index) => {
      messages.push({ messageId: message.message_id, mediaIndex: index, kind: 'media' });
    });
  } else {
    const single = payloads[0];
    if (!single) throw new Error('approved payload carries no media');

    const sent =
      payload.method === 'sendVideo'
        ? await sendVideo(context, single, payload.caption)
        : await sendPhoto(context, single, payload.caption);
    messages.push({ messageId: sent.message_id, mediaIndex: 0, kind: 'media' });
  }

  const primaryMessageId = messages[0]?.messageId ?? null;

  if (payload.overflowMessage) {
    try {
      await sleep(TELEGRAM_MIN_DELAY_BETWEEN_SENDS_MS);
      const followUp = await sendText(context, payload.overflowMessage, {
        replyToMessageId: primaryMessageId ?? undefined,
      });
      messages.push({ messageId: followUp.message_id, mediaIndex: null, kind: 'text' });
    } catch (error) {
      // The media is already in the channel; losing the tail must not fail the
      // publish and trigger a retry that would duplicate the album.
      options?.logger?.warn('approval.overflow_text_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { messages, primaryMessageId, method: payload.method };
}
