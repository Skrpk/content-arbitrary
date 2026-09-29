import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { describeError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { TelegramClient } from '@/lib/telegram/client';
import { TELEGRAM_PARSE_MODE, escapeHtml } from '@/lib/telegram/format-caption';
import type { SendContext } from '@/lib/telegram/send-media';
import { parseCallbackData, publishApprovedPayload } from '@/lib/sync/approval';
import { dispatchCommand, isAuthorizedAdmin, parseCommand } from '@/lib/telegram/commands';
import { XClient } from '@/lib/x/client';
import type { Logger } from '@/lib/logger';
import {
  claimForDecision,
  markPublished,
  markRejected,
  releaseToApproval,
} from '@/lib/sync/repository';

/**
 * POST /api/telegram/webhook — receives Approve / Reject button presses.
 *
 * Inline keyboards deliver their callbacks over a webhook, which a cron-only
 * application has no other way to receive. Telegram calls this endpoint.
 *
 * Two independent checks guard it:
 *   1. the `X-Telegram-Bot-Api-Secret-Token` header must match
 *      TELEGRAM_WEBHOOK_SECRET, proving the call really came from Telegram;
 *   2. the pressing user must be TELEGRAM_ADMIN_CHAT_ID, so that forwarding the
 *      message to someone else does not hand them the publish button.
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

export async function POST(request: Request): Promise<Response> {
  const logger = createLogger({ app: 'content-arbitrary', surface: 'webhook' });

  let env: ReturnType<typeof getEnv>;
  try {
    env = getEnv();
  } catch (error) {
    logger.error('webhook.misconfigured', { error: describeError(error) });
    return new Response('misconfigured', { status: 500 });
  }

  if (!env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_ADMIN_CHAT_ID) {
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

  // Slash commands manage the source list. Same admin check as the buttons.
  if (update.message) {
    await handleCommandMessage(update.message, { env, client, logger });
    return ok();
  }

  const query = update.callback_query;
  if (!query) return ok();

  // Anyone can be forwarded the message; only the reviewer may act on it.
  if (!isAuthorizedAdmin(query.from.id, env.TELEGRAM_ADMIN_CHAT_ID)) {
    logger.warn('webhook.unauthorized_user', { fromId: query.from.id });
    await client
      .answerCallbackQuery(query.id, 'You are not authorised to review posts.')
      .catch(() => {});
    return ok();
  }

  const parsed = parseCallbackData(query.data);
  if (!parsed) {
    logger.warn('webhook.unparsable_callback', {});
    await client.answerCallbackQuery(query.id, 'Unrecognised action.').catch(() => {});
    return ok();
  }

  const postLogger = logger.child({ postId: parsed.postId, action: parsed.action });
  const db = getDb();

  // A single conditional UPDATE decides the winner, so a double tap — or an
  // Approve racing a Reject — can only ever act once.
  const claim = await claimForDecision(db, parsed.postId);

  if (!claim.claimed || !claim.row) {
    const status = claim.currentStatus ?? 'unknown';
    postLogger.info('webhook.already_decided', { currentStatus: status });
    await client
      .answerCallbackQuery(
        query.id,
        status === 'published'
          ? 'Already published.'
          : status === 'rejected'
            ? 'Already rejected.'
            : `Not awaiting review (status: ${status}).`,
      )
      .catch(() => {});
    return ok();
  }

  const adminChatId = claim.row.adminChatId ?? String(query.message?.chat.id ?? '');
  const adminMessageId = claim.row.adminMessageId ?? query.message?.message_id;

  const stripButtons = async (note: string) => {
    if (!adminChatId || !adminMessageId) return;
    await client
      .editMessageText(adminChatId, adminMessageId, note, TELEGRAM_PARSE_MODE)
      // Whatever the message turns out to be, at minimum take the buttons away
      // so a settled post cannot be actioned again from the chat.
      .catch(() => client.editMessageReplyMarkup(adminChatId, adminMessageId).catch(() => {}));
  };

  if (parsed.action === 'reject') {
    await markRejected(db, parsed.postId);
    postLogger.info('webhook.rejected', { xPostId: claim.row.xPostId });

    await client.answerCallbackQuery(query.id, 'Rejected — not published.').catch(() => {});
    await stripButtons(`🚫 Rejected\n${escapeHtml(claim.row.xPostUrl)}`);
    return ok();
  }

  const payload = claim.row.approvalPayload;
  if (!payload || payload.items.length === 0) {
    const reason = 'approval payload is missing; re-run the sync for this post';
    postLogger.error('webhook.missing_payload', { xPostId: claim.row.xPostId });
    await releaseToApproval(db, { id: parsed.postId, errorMessage: reason });
    await client.answerCallbackQuery(query.id, 'Cannot publish: media reference lost.').catch(() => {});
    return ok();
  }

  const channelContext: SendContext = {
    client,
    chatId: env.TELEGRAM_CHAT_ID,
    disableNotification: env.TELEGRAM_DISABLE_NOTIFICATION,
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
      telegramChatId: env.TELEGRAM_CHAT_ID,
      primaryMessageId: result.primaryMessageId,
      telegramMethod: result.method,
      mediaCount: payload.items.length,
      messages: result.messages,
    });

    postLogger.info('webhook.published', {
      xPostId: claim.row.xPostId,
      telegramMessageIds: result.messages.map((message) => message.messageId),
    });

    await client.answerCallbackQuery(query.id, 'Published to the channel.').catch(() => {});
    await stripButtons(`✅ Published\n${escapeHtml(claim.row.xPostUrl)}`);
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
 * Only the configured reviewer may manage sources; anyone else is ignored
 * silently rather than told what the bot is, so a stranger who finds it learns
 * nothing about the setup.
 */
async function handleCommandMessage(
  message: { chat: { id: number }; from?: { id: number }; text?: string },
  context: { env: ReturnType<typeof getEnv>; client: TelegramClient; logger: Logger },
): Promise<void> {
  const { env, client, logger } = context;

  const parsed = parseCommand(message.text);
  if (!parsed) return;

  if (!isAuthorizedAdmin(message.from?.id, env.TELEGRAM_ADMIN_CHAT_ID)) {
    logger.warn('webhook.unauthorized_command', {
      fromId: message.from?.id,
      command: parsed.command,
    });
    return;
  }

  const chatId = String(message.chat.id);

  try {
    const reply = await dispatchCommand(
      { db: getDb(), xClient: new XClient({ logger }), logger },
      parsed,
    );
    if (!reply) return;

    await client.call(
      'sendMessage',
      {
        chat_id: chatId,
        text: reply,
        parse_mode: TELEGRAM_PARSE_MODE,
        link_preview_options: { is_disabled: true },
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
