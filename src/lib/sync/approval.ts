import {
  isRejectionReason,
  REJECTION_REASONS,
  type ApprovalMediaItem,
  type ApprovalPayload,
  type RejectionReason,
} from '@/db/schema';
import type { Logger } from '@/lib/logger';
import { mediaFileIdOf, type TelegramClient, type TelegramMessage } from '@/lib/telegram/client';
import { escapeHtml, formatMessageText, TELEGRAM_PARSE_MODE } from '@/lib/telegram/format-caption';
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

/**
 * What a button press asks for.
 *
 * Reject does not settle anything: it only swaps the buttons for the list of
 * reasons, and the post is rejected when one of those is chosen. `reject_back`
 * undoes a mis-tapped Reject by bringing the original buttons back.
 */
export type ApprovalAction = 'approve' | 'reject' | 'reject_back';

export type ApprovalCallback =
  | { action: ApprovalAction; postId: number }
  | { action: 'reject_reason'; postId: number; reason: RejectionReason };

const ACTION_CODES: Record<ApprovalAction, string> = {
  approve: 'ap',
  reject: 'rj',
  reject_back: 'rb',
};

const ACTIONS_BY_CODE = Object.fromEntries(
  Object.entries(ACTION_CODES).map(([action, code]) => [code, action]),
) as Record<string, ApprovalAction>;

/** Button labels. The stored value is the key; the wording may change freely. */
export const REJECTION_REASON_LABELS: Record<RejectionReason, string> = {
  not_interesting: '😴 Not interesting',
  wrong_topic: '🎯 Off-topic',
  already_covered: '♻️ Already covered',
  too_minor: '🤏 Too minor',
  weak_source: '📰 Weak source',
  other: '••• Other',
};

/** Long enough for a sentence or two of why, short enough to stay a reason. */
export const REJECTION_NOTE_MAX_LENGTH = 500;

/** Telegram caps callback_data at 64 bytes, so keep it to a verb and an id. */
export function buildCallbackData(action: ApprovalAction, postId: number): string {
  return `${ACTION_CODES[action]}:${postId}`;
}

/** The longest, `rr:<12 digits>:already_covered`, is 31 bytes. */
export function buildRejectReasonCallbackData(postId: number, reason: RejectionReason): string {
  return `rr:${postId}:${reason}`;
}

export function parseCallbackData(data: string | undefined): ApprovalCallback | null {
  if (!data) return null;

  const match = /^(ap|rj|rb|rr):(\d{1,12})(?::([a-z_]{1,32}))?$/.exec(data.trim());
  if (!match) return null;

  const postId = Number(match[2]);
  if (!Number.isSafeInteger(postId) || postId <= 0) return null;

  const [, code, , reason] = match;

  // A reason travels only with `rr`, and only one we know: anything else is
  // refused here, before it can reach the database.
  if (code === 'rr') {
    return reason && isRejectionReason(reason)
      ? { action: 'reject_reason', postId, reason }
      : null;
  }
  if (reason !== undefined) return null;

  return { action: ACTIONS_BY_CODE[code!]!, postId };
}

/**
 * Absolute URL of the Mini App that edits this post's caption.
 *
 * Absolute because Telegram opens it itself, not the chat client's current
 * origin; the post id travels in the query string, which is safe — it is an
 * internal row id and the Mini App proves who is asking with its own signed
 * init data before the id means anything.
 */
export function buildEditUrl(baseUrl: string, postId: number): string {
  return `${baseUrl.replace(/\/+$/, '')}/review?post=${postId}`;
}

/** Mini App where the reviewer writes their own reason, for "Other". */
export function buildRejectNoteUrl(baseUrl: string, postId: number): string {
  return `${baseUrl.replace(/\/+$/, '')}/review/reject?post=${postId}`;
}

export function buildApprovalKeyboard(
  postId: number,
  options?: { editUrl?: string },
): InlineKeyboardMarkup {
  const decide = [
    { text: '✅ Approve', callback_data: buildCallbackData('approve', postId) },
    { text: '🚫 Reject', callback_data: buildCallbackData('reject', postId) },
  ];

  // Its own row: Edit opens a Mini App rather than settling the post, and
  // sitting beside the two final actions invites a misclick.
  return {
    inline_keyboard: options?.editUrl
      ? [decide, [{ text: '✏️ Edit text', web_app: { url: options.editUrl } }]]
      : [decide],
  };
}

/**
 * Shown in place of the review buttons once Reject is pressed.
 *
 * With a Mini App available, "Other" opens it so the reviewer can say why in
 * their own words; without one it rejects straight away like the rest.
 */
export function buildRejectReasonKeyboard(
  postId: number,
  options?: { otherUrl?: string },
): InlineKeyboardMarkup {
  const reasons: InlineKeyboardMarkup['inline_keyboard'][number] = REJECTION_REASONS.map(
    (reason) =>
      reason === 'other' && options?.otherUrl
        ? { text: REJECTION_REASON_LABELS[reason], web_app: { url: options.otherUrl } }
        : {
            text: REJECTION_REASON_LABELS[reason],
            callback_data: buildRejectReasonCallbackData(postId, reason),
          },
  );

  const rows: InlineKeyboardMarkup['inline_keyboard'] = [];
  for (let index = 0; index < reasons.length; index += 2) {
    rows.push(reasons.slice(index, index + 2));
  }
  rows.push([{ text: '↩️ Back', callback_data: buildCallbackData('reject_back', postId) }]);

  return { inline_keyboard: rows };
}

/** The note left in place of the review buttons once a post is rejected. */
export function formatRejectionNotice(input: {
  reason: RejectionReason;
  note?: string | null;
  xPostUrl: string;
}): string {
  const note = input.note?.trim();
  return [
    '🚫 Rejected',
    `Reason: ${REJECTION_REASON_LABELS[input.reason]}`,
    // The reviewer's own text is plain; it must not be read as markup.
    ...(note ? [`“${escapeHtml(note)}”`] : []),
    escapeHtml(input.xPostUrl),
  ].join('\n');
}

/** Replace the review buttons with a note of the decision. */
export async function settleReviewMessage(
  client: TelegramClient,
  chatId: string | null | undefined,
  messageId: number | null | undefined,
  note: string,
): Promise<void> {
  if (!chatId || !messageId) return;
  await client
    .editMessageText(chatId, messageId, note, TELEGRAM_PARSE_MODE)
    // Whatever the message turns out to be, at minimum take the buttons away
    // so a settled post cannot be actioned again from the chat.
    .catch(() => client.editMessageReplyMarkup(chatId, messageId).catch(() => {}));
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
  /** Handle the post came from, shown in the preview. */
  sourceUsername: string;
  method: Exclude<TelegramMethod, 'sendMessage' | 'none'>;
  caption: string;
  overflowMessage?: string;
  payloads: MediaPayload[];
  /** Mini App URL for the Edit button; omitted when APP_BASE_URL is unset. */
  editUrl?: string;
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
  const keyboard = buildApprovalKeyboard(request.postId, { editUrl: request.editUrl });

  /**
   * The media is sent exactly as it would appear in the channel — same caption,
   * no extra markup — so the preview shows the real thing. Review metadata and
   * the buttons go on a separate message underneath.
   *
   * Keeping them apart matters twice over: an album cannot carry an inline
   * keyboard at all, and anything added to the caption here would be stored and
   * published verbatim on approval.
   */
  let mediaMessages: TelegramMessage[];

  if (request.method === 'sendMediaGroup') {
    mediaMessages = await sendMediaGroup(
      { ...context, replyMarkup: undefined },
      request.payloads,
      request.caption,
    );
  } else {
    const single = request.payloads[0]!;
    const sent =
      request.method === 'sendVideo'
        ? await sendVideo({ ...context, replyMarkup: undefined }, single, request.caption)
        : await sendPhoto({ ...context, replyMarkup: undefined }, single, request.caption);
    mediaMessages = [sent];
  }

  await sleep(TELEGRAM_MIN_DELAY_BETWEEN_SENDS_MS);

  /**
   * A text too long for a caption reaches the channel as a second message on
   * Approve, so the reviewer sees that too — exactly as it will be sent.
   *
   * Best effort: the media is already in the reviewer's chat, and failing the
   * review here would send it all again on the retry. Without this preview
   * the post can still be reviewed from its caption.
   */
  let overflowMessageId: number | undefined;

  if (request.overflowMessage) {
    try {
      const overflow = await sendText(
        { ...context, replyMarkup: undefined },
        request.overflowMessage,
        { replyToMessageId: mediaMessages[0]?.message_id },
      );
      overflowMessageId = overflow.message_id;
    } catch (error) {
      options?.logger?.warn('approval.overflow_preview_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await sleep(TELEGRAM_MIN_DELAY_BETWEEN_SENDS_MS);
  }

  const control = await sendText(
    { ...context, replyMarkup: keyboard },
    formatMessageText(
      `Source: @${request.sourceUsername.replace(/^@/, '')}\n${request.xPostUrl}`,
    ),
    { replyToMessageId: mediaMessages[0]?.message_id },
  );
  const buttonMessageId = control.message_id;

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
      adminMediaMessageId: mediaMessages[0]?.message_id,
      adminOverflowMessageId: overflowMessageId,
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
