import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getDb, type Database } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { describeError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { TelegramClient } from '@/lib/telegram/client';
import { TELEGRAM_PARSE_MODE, escapeHtml } from '@/lib/telegram/format-caption';
import type { SendContext } from '@/lib/telegram/send-media';
import {
  buildApprovalKeyboard,
  buildEditUrl,
  buildRejectNoteUrl,
  buildRejectReasonKeyboard,
  formatRejectionNotice,
  parseCallbackData,
  publishApprovedPayload,
  settleReviewMessage,
} from '@/lib/sync/approval';
import { buildSettingsUrl, dispatchCommand, parseCommand } from '@/lib/telegram/commands';
import { destinationFor, findWorkspaceByAdminChatId } from '@/lib/workspace';
import { XClient } from '@/lib/x/client';
import type { Logger } from '@/lib/logger';
import {
  claimForDecision,
  findPostAwaitingReview,
  findStatusInWorkspace,
  markPublished,
  rejectWithReason,
  releaseToApproval,
} from '@/lib/sync/repository';
import type { PostStatus } from '@/db/schema';

/**
 * POST /api/telegram/webhook — receives the review buttons' presses.
 *
 * Approve publishes. Reject only swaps the buttons for a list of reasons (and a
 * Back button); choosing a reason is what rejects the post, so every rejection
 * records why.
 *
 * Inline keyboards deliver their callbacks over a webhook, which a cron-only
 * application has no other way to receive. Telegram calls this endpoint.
 *
 * Two independent checks guard it:
 *   1. the `X-Telegram-Bot-Api-Secret-Token` header must match
 *      TELEGRAM_WEBHOOK_SECRET, proving the call really came from Telegram;
 *   2. the pressing user must be some workspace's reviewer, so that forwarding
 *      the message to someone else does not hand them the publish button.
 *
 * The second check also decides which tenant the request acts on: one bot
 * serves every workspace, so the sender's id is what tells them apart. The
 * claim below is scoped to that tenant as well, because a callback carries only
 * a post id and nothing stops one reviewer sending another's.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const callbackQuerySchema = z.object({
  id: z.string(),
  from: z.object({ id: z.number(), username: z.string().optional() }),
  data: z.string().optional(),
  message: z
    .object({
      message_id: z.number(),
      chat: z.object({ id: z.number() }),
    })
    .optional(),
});

const messageSchema = z.object({
  message_id: z.number(),
  from: z.object({ id: z.number(), username: z.string().optional() }).optional(),
  chat: z.object({ id: z.number(), type: z.string().optional() }),
  text: z.string().optional(),
});

const updateSchema = z.object({
  update_id: z.number().optional(),
  callback_query: callbackQuerySchema.optional(),
  message: messageSchema.optional(),
});

function secretMatches(presented: string | null, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Telegram retries any webhook that does not answer 2xx, and a retry after we
 * have already published would be harmful. So every handled outcome — including
 * a rejected or malformed update — returns 200; real problems go to the logs.
 */
const ok = () => new Response('ok', { status: 200 });

/** What a reviewer is told when the post they pressed on is already settled. */
function alreadySettledNotice(status: PostStatus | undefined): string {
  if (status === 'published') return 'Already published.';
  if (status === 'rejected') return 'Already rejected.';
  return `Not awaiting review (status: ${status ?? 'unknown'}).`;
}

export async function POST(request: Request): Promise<Response> {
  const logger = createLogger({ app: 'content-arbitrary', surface: 'webhook' });

  let env: ReturnType<typeof getEnv>;
  try {
    env = getEnv();
  } catch (error) {
    logger.error('webhook.misconfigured', { error: describeError(error) });
    return new Response('misconfigured', { status: 500 });
  }

  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    logger.warn('webhook.approval_disabled', {});
    return new Response('approval not configured', { status: 404 });
  }

  if (!secretMatches(request.headers.get('x-telegram-bot-api-secret-token'), env.TELEGRAM_WEBHOOK_SECRET)) {
    logger.warn('webhook.bad_secret', {});
    return new Response('forbidden', { status: 403 });
  }

  let update: z.infer<typeof updateSchema>;
  try {
    update = updateSchema.parse(await request.json());
  } catch (error) {
    logger.warn('webhook.unparsable_update', { error: describeError(error) });
    return ok();
  }

  const client = new TelegramClient({ logger });
  const db = getDb();

  // Slash commands manage the source list. Same tenant lookup as the buttons.
  if (update.message) {
    await handleCommandMessage(update.message, {
      db,
      client,
      logger,
      settingsUrl: env.APP_BASE_URL ? buildSettingsUrl(env.APP_BASE_URL) : undefined,
    });
    return ok();
  }

  const query = update.callback_query;
  if (!query) return ok();

  // Anyone can be forwarded the message; only a reviewer may act on it, and
  // only on their own tenant's posts.
  const workspace = await findWorkspaceByAdminChatId(db, query.from.id);
  if (!workspace) {
    logger.warn('webhook.unauthorized_user', { fromId: query.from.id });
    await client
      .answerCallbackQuery(query.id, 'You are not authorised to review posts.')
      .catch(() => {});
    return ok();
  }

  const resolved = destinationFor(workspace, env);
  if (!resolved.ok) {
    logger.error('webhook.workspace_unpublishable', {
      workspaceId: workspace.id,
      reason: resolved.reason,
    });
    await client.answerCallbackQuery(query.id, 'This channel is not configured.').catch(() => {});
    return ok();
  }

  const parsed = parseCallbackData(query.data);
  if (!parsed) {
    logger.warn('webhook.unparsable_callback', {});
    await client.answerCallbackQuery(query.id, 'Unrecognised action.').catch(() => {});
    return ok();
  }

  const postLogger = logger.child({
    postId: parsed.postId,
    action: parsed.action,
    workspaceId: workspace.id,
  });

  // Reject and Back only change which buttons are showing; nothing is decided,
  // so they touch no state and need no claim.
  if (parsed.action === 'reject' || parsed.action === 'reject_back') {
    const post = await findPostAwaitingReview(db, { id: parsed.postId, workspaceId: workspace.id });
    if (!post) {
      const status = await findStatusInWorkspace(db, { id: parsed.postId, workspaceId: workspace.id });
      postLogger.info('webhook.already_decided', { currentStatus: status ?? 'unknown' });
      await client.answerCallbackQuery(query.id, alreadySettledNotice(status)).catch(() => {});
      return ok();
    }

    const chatId = post.adminChatId ?? String(query.message?.chat.id ?? '');
    const messageId = post.adminMessageId ?? query.message?.message_id;
    const baseUrl = env.APP_BASE_URL;
    const keyboard =
      parsed.action === 'reject'
        ? buildRejectReasonKeyboard(post.id, {
            otherUrl: baseUrl ? buildRejectNoteUrl(baseUrl, post.id) : undefined,
          })
        : buildApprovalKeyboard(post.id, {
            editUrl: baseUrl ? buildEditUrl(baseUrl, post.id) : undefined,
          });

    try {
      if (chatId && messageId) await client.editMessageReplyMarkup(chatId, messageId, keyboard);
    } catch (error) {
      const message = describeError(error);
      // A repeated tap re-sends the keyboard already showing, which Telegram
      // refuses as "not modified" — the screen is already right.
      if (!/message is not modified/i.test(message)) {
        postLogger.warn('webhook.keyboard_swap_failed', { error: message });
        await client.answerCallbackQuery(query.id, 'Could not update the buttons — try again.').catch(() => {});
        return ok();
      }
    }

    await client
      .answerCallbackQuery(query.id, parsed.action === 'reject' ? 'Why does it not fit?' : undefined)
      .catch(() => {});
    return ok();
  }

  if (parsed.action === 'reject_reason') {
    // One guarded UPDATE: a double tap, a stale message, or a reason chosen
    // after Approve already won all find the post settled and change nothing.
    const result = await rejectWithReason(db, {
      id: parsed.postId,
      workspaceId: workspace.id,
      reason: parsed.reason,
    });

    if (!result.rejected || !result.row) {
      postLogger.info('webhook.already_decided', { currentStatus: result.currentStatus ?? 'unknown' });
      await client.answerCallbackQuery(query.id, alreadySettledNotice(result.currentStatus)).catch(() => {});
      return ok();
    }

    postLogger.info('webhook.rejected', { xPostId: result.row.xPostId, reason: parsed.reason });
    await client.answerCallbackQuery(query.id, 'Rejected — not published.').catch(() => {});
    await settleReviewMessage(
      client,
      result.row.adminChatId ?? String(query.message?.chat.id ?? ''),
      result.row.adminMessageId ?? query.message?.message_id,
      formatRejectionNotice({ reason: parsed.reason, xPostUrl: result.row.xPostUrl }),
    );
    return ok();
  }

  // A single conditional UPDATE decides the winner, so a double tap — or an
  // Approve racing a rejection — can only ever act once. Scoped to the
  // presser's tenant, so a post id from another tenant simply does not match.
  const claim = await claimForDecision(db, parsed.postId, workspace.id);

  if (!claim.claimed || !claim.row) {
    postLogger.info('webhook.already_decided', { currentStatus: claim.currentStatus ?? 'unknown' });
    await client.answerCallbackQuery(query.id, alreadySettledNotice(claim.currentStatus)).catch(() => {});
    return ok();
  }

  const adminChatId = claim.row.adminChatId ?? String(query.message?.chat.id ?? '');
  const adminMessageId = claim.row.adminMessageId ?? query.message?.message_id;

  const stored = claim.row.approvalPayload;
  // A text-only post has no media by design; any other post without it does.
  if (!stored || (stored.method !== 'sendMessage' && stored.items.length === 0)) {
    const reason = 'approval payload is missing; re-run the sync for this post';
    postLogger.error('webhook.missing_payload', { xPostId: claim.row.xPostId });
    await releaseToApproval(db, { id: parsed.postId, errorMessage: reason });
    await client.answerCallbackQuery(query.id, 'Cannot publish: media reference lost.').catch(() => {});
    return ok();
  }

  // The caption column, not the payload's copy, is what gets published: it is
  // the one an edit is guaranteed to have written. The fallback covers a post
  // queued by the previous deploy, before the column existed.
  const payload = { ...stored, caption: claim.row.caption ?? stored.caption };

  const channelContext: SendContext = {
    client,
    chatId: resolved.destination.chatId,
    disableNotification: resolved.destination.disableNotification,
  };

  try {
    postLogger.info('webhook.publishing', {
      xPostId: claim.row.xPostId,
      method: payload.method,
      mediaCount: payload.items.length,
    });

    const result = await publishApprovedPayload(channelContext, payload, { logger: postLogger });

    await markPublished(db, {
      id: parsed.postId,
      telegramChatId: resolved.destination.chatId,
      primaryMessageId: result.primaryMessageId,
      telegramMethod: result.method,
      mediaCount: payload.items.length,
      messages: result.messages,
      reviewedAt: new Date(),
    });

    postLogger.info('webhook.published', {
      xPostId: claim.row.xPostId,
      telegramMessageIds: result.messages.map((message) => message.messageId),
    });

    await client.answerCallbackQuery(query.id, 'Published to the channel.').catch(() => {});
    await settleReviewMessage(
      client,
      adminChatId,
      adminMessageId,
      `✅ Published\n${escapeHtml(claim.row.xPostUrl)}`,
    );
  } catch (error) {
    // Put it back in the queue so the reviewer can simply press Approve again.
    const message = describeError(error);
    postLogger.error('webhook.publish_failed', { xPostId: claim.row.xPostId, error: message });
    await releaseToApproval(db, { id: parsed.postId, errorMessage: message });
    await client.answerCallbackQuery(query.id, 'Publishing failed — try again.').catch(() => {});
  }

  return ok();
}

/**
 * Run a slash command sent to the bot.
 *
 * Only a workspace's own reviewer may manage its sources; anyone else is
 * ignored silently rather than told what the bot is, so a stranger who finds it
 * learns nothing about the setup. The sender's id is also what selects the
 * tenant, since one bot serves them all.
 */
async function handleCommandMessage(
  message: { chat: { id: number }; from?: { id: number }; text?: string },
  context: {
    db: Database;
    client: TelegramClient;
    logger: Logger;
    /** The source settings Mini App; no Settings button without one. */
    settingsUrl?: string;
  },
): Promise<void> {
  const { db, client, logger } = context;

  const parsed = parseCommand(message.text);
  if (!parsed) return;

  const workspace = await findWorkspaceByAdminChatId(db, message.from?.id);
  if (!workspace) {
    logger.warn('webhook.unauthorized_command', {
      fromId: message.from?.id,
      command: parsed.command,
    });
    return;
  }

  const chatId = String(message.chat.id);

  try {
    const reply = await dispatchCommand(
      {
        db,
        xClient: new XClient({ logger }),
        logger: logger.child({ workspaceId: workspace.id }),
        workspaceId: workspace.id,
      },
      parsed,
    );
    if (!reply) return;

    await client.call(
      'sendMessage',
      {
        chat_id: chatId,
        text: reply.text,
        parse_mode: TELEGRAM_PARSE_MODE,
        link_preview_options: { is_disabled: true },
        ...(reply.offerSettings && context.settingsUrl
          ? {
              reply_markup: {
                inline_keyboard: [[{ text: '⚙️ Settings', web_app: { url: context.settingsUrl } }]],
              },
            }
          : {}),
      },
      z.object({ message_id: z.number() }),
    );
  } catch (error) {
    // A failing command must never take the webhook down, or Telegram will
    // retry it and run the same command again.
    logger.error('webhook.command_failed', {
      command: parsed.command,
      error: describeError(error),
    });
    await client
      .call(
        'sendMessage',
        { chat_id: chatId, text: '⚠️ Something went wrong running that command.' },
        z.object({ message_id: z.number() }),
      )
      .catch(() => {});
  }
}
