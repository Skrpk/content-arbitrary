import { loadRadarNote } from '@/lib/radar/review-note';
import { sourceLabelOfPost } from '@/lib/sources/display';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getDb, type Database } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { describeError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { TelegramClient } from '@/lib/telegram/client';
import { TELEGRAM_PARSE_MODE, escapeHtml } from '@/lib/telegram/format-caption';
import {
  buildApprovalKeyboard,
  buildRejectNoteUrl,
  buildRejectReasonKeyboard,
  formatRejectionNotice,
  formatReviewControlText,
  parseCallbackData,
  reviewLinks,
  settleReviewMessage,
} from '@/lib/sync/approval';
import { publishDecidedPost } from '@/lib/sync/publish';
import {
  buildSettingsUrl,
  buildSourceStatsUrl,
  dispatchCommand,
  parseChannelChoice,
  parseCommand,
  runChosenChannel,
  type CommandContext,
  type CommandReply,
} from '@/lib/telegram/commands';
import {
  channelLabelFor,
  destinationFor,
  findWorkspacesByAdminChatId,
  workspaceForPost,
} from '@/lib/workspace';
import type { Workspace } from '@/db/schema';
import { XClient } from '@/lib/x/client';
import type { Logger } from '@/lib/logger';
import {
  claimForDecision,
  findPostAwaitingReview,
  findStatusInWorkspace,
  rejectWithReason,
  releaseToApproval,
  returnToSchedule,
  unschedulePost,
} from '@/lib/sync/repository';
import type { PostStatus } from '@/db/schema';

/**
 * POST /api/telegram/webhook — receives the review buttons' presses.
 *
 * Approve publishes. Reject only swaps the buttons for a list of reasons (and a
 * Back button); choosing a reason is what rejects the post, so every rejection
 * records why. Schedule is a Mini App, not a callback; once a post is
 * scheduled its buttons are Publish now and Unschedule.
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
  if (status === 'scheduled') return 'Already scheduled — use its own buttons.';
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
      appBaseUrl: env.APP_BASE_URL,
    });
    return ok();
  }

  const query = update.callback_query;
  if (!query) return ok();

  // Anyone can be forwarded the message; only a reviewer may act on it, and
  // only on the posts of channels they review.
  const reviewerWorkspaces = await findWorkspacesByAdminChatId(db, query.from.id);
  if (reviewerWorkspaces.length === 0) {
    logger.warn('webhook.unauthorized_user', { fromId: query.from.id });
    await client
      .answerCallbackQuery(query.id, 'You are not authorised to review posts.')
      .catch(() => {});
    return ok();
  }

  // A channel button under a source command, for a reviewer of several.
  const choice = parseChannelChoice(query.data);
  if (choice) {
    await handleChannelChoice(query, choice, {
      db,
      client,
      logger,
      workspaces: reviewerWorkspaces,
      appBaseUrl: env.APP_BASE_URL,
    });
    return ok();
  }

  const parsed = parseCallbackData(query.data);
  if (!parsed) {
    logger.warn('webhook.unparsable_callback', {});
    await client.answerCallbackQuery(query.id, 'Unrecognised action.').catch(() => {});
    return ok();
  }

  /**
   * The post decides the tenant: a reviewer of several channels acts on each
   * post in its own channel. A post of a channel they do not review gets the
   * same answer as one that does not exist.
   */
  const workspace = await workspaceForPost(db, reviewerWorkspaces, parsed.postId);
  if (!workspace) {
    logger.info('webhook.post_not_reviewable', { postId: parsed.postId, fromId: query.from.id });
    await client.answerCallbackQuery(query.id, alreadySettledNotice(undefined)).catch(() => {});
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
        : buildApprovalKeyboard(post.id, reviewLinks(baseUrl, post.id));

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

  if (parsed.action === 'unschedule') {
    // Back to the review queue: the decision is undone, nothing is sent.
    const result = await unschedulePost(db, { id: parsed.postId, workspaceId: workspace.id });

    if (!result.unscheduled || !result.row) {
      postLogger.info('webhook.already_decided', { currentStatus: result.currentStatus ?? 'unknown' });
      await client.answerCallbackQuery(query.id, alreadySettledNotice(result.currentStatus)).catch(() => {});
      return ok();
    }

    postLogger.info('webhook.unscheduled', { xPostId: result.row.xPostId });
    await client.answerCallbackQuery(query.id, 'Unscheduled — back in review.').catch(() => {});

    const chatId = result.row.adminChatId ?? String(query.message?.chat.id ?? '');
    const messageId = result.row.adminMessageId ?? query.message?.message_id;
    if (chatId && messageId) {
      await client
        .editMessageText(
          chatId,
          messageId,
          formatReviewControlText(
            sourceLabelOfPost(result.row.xPostId, result.row.xAuthorUsername),
            result.row.xPostUrl,
            channelLabelFor(workspace, reviewerWorkspaces.length),
            await loadRadarNote(db, result.row.id).catch(() => null),
          ),
          TELEGRAM_PARSE_MODE,
          buildApprovalKeyboard(result.row.id, reviewLinks(env.APP_BASE_URL, result.row.id)),
        )
        .catch((error: unknown) => {
          postLogger.warn('webhook.keyboard_swap_failed', { error: describeError(error) });
        });
    }
    return ok();
  }

  /**
   * Approve, or Publish now on a scheduled post: either way it goes out now.
   * A single conditional UPDATE decides the winner, so a double tap — or one
   * racing a rejection, or the scheduler — can only ever act once. Scoped to
   * the presser's tenant, so a post id from another tenant simply does not
   * match.
   */
  const fromSchedule = parsed.action === 'publish_now';
  const claim = await claimForDecision(
    db,
    parsed.postId,
    workspace.id,
    fromSchedule ? ['scheduled'] : ['awaiting_approval'],
  );

  if (!claim.claimed || !claim.row) {
    postLogger.info('webhook.already_decided', { currentStatus: claim.currentStatus ?? 'unknown' });
    await client.answerCallbackQuery(query.id, alreadySettledNotice(claim.currentStatus)).catch(() => {});
    return ok();
  }

  const adminChatId = claim.row.adminChatId ?? String(query.message?.chat.id ?? '');
  const adminMessageId = claim.row.adminMessageId ?? query.message?.message_id;

  /** Return the post to where it was claimed from, so it can be tried again. */
  const putBack = (errorMessage: string) =>
    fromSchedule
      ? returnToSchedule(db, { id: parsed.postId, errorMessage, countAttempt: false })
      : releaseToApproval(db, { id: parsed.postId, errorMessage });

  const payload = claim.row.approvalPayload;
  // A text-only post has no media by design; any other post without it does.
  if (!payload || (payload.method !== 'sendMessage' && payload.items.length === 0)) {
    const reason = 'approval payload is missing; re-run the sync for this post';
    postLogger.error('webhook.missing_payload', { xPostId: claim.row.xPostId });
    await putBack(reason);
    await client.answerCallbackQuery(query.id, 'Cannot publish: media reference lost.').catch(() => {});
    return ok();
  }

  try {
    postLogger.info('webhook.publishing', {
      xPostId: claim.row.xPostId,
      method: payload.method,
      mediaCount: payload.items.length,
    });

    const result = await publishDecidedPost({
      db,
      client,
      row: claim.row,
      payload,
      destination: resolved.destination,
      logger: postLogger,
      // A scheduled post was decided when it was scheduled.
      reviewedAt: fromSchedule ? undefined : new Date(),
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
    // Put it back so the reviewer can simply press the button again.
    const message = describeError(error);
    postLogger.error('webhook.publish_failed', { xPostId: claim.row.xPostId, error: message });
    await putBack(message);
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
    /** Where the Mini Apps live; no Mini App buttons without it. */
    appBaseUrl?: string;
  },
): Promise<void> {
  const { db, client, logger } = context;

  const parsed = parseCommand(message.text);
  if (!parsed) return;

  const reviewerWorkspaces = await findWorkspacesByAdminChatId(db, message.from?.id);
  const workspace = reviewerWorkspaces[0];
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
        logger: logger.child({ fromId: message.from?.id }),
        workspaceId: workspace.id,
        workspaces: reviewerWorkspaces.map(({ id, name }) => ({ id, name })),
      },
      parsed,
    );
    if (!reply) return;

    const markup = replyMarkupFor(reply, context.appBaseUrl);
    await client.call(
      'sendMessage',
      {
        chat_id: chatId,
        text: reply.text,
        parse_mode: TELEGRAM_PARSE_MODE,
        link_preview_options: { is_disabled: true },
        ...(markup ? { reply_markup: markup } : {}),
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

/** A command reply's own buttons, or the Mini App buttons it offers: stats first, then settings. */
function replyMarkupFor(reply: CommandReply, appBaseUrl: string | undefined) {
  if (reply.replyMarkup) return reply.replyMarkup;
  if (!appBaseUrl) return undefined;

  const rows = [
    ...(reply.offerStats ? [[{ text: '📊 Open stats', web_app: { url: buildSourceStatsUrl(appBaseUrl) } }]] : []),
    ...(reply.offerSettings ? [[{ text: '⚙️ Settings', web_app: { url: buildSettingsUrl(appBaseUrl) } }]] : []),
  ];
  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

/**
 * A channel picked for a source command. The question is replaced by the
 * outcome, so the buttons cannot be pressed a second time.
 */
async function handleChannelChoice(
  query: { id: string; message?: { message_id: number; chat: { id: number } } },
  choice: NonNullable<ReturnType<typeof parseChannelChoice>>,
  context: {
    db: Database;
    client: TelegramClient;
    logger: Logger;
    workspaces: Workspace[];
    appBaseUrl?: string;
  },
): Promise<void> {
  const { client, logger } = context;
  const commandContext: CommandContext = {
    db: context.db,
    xClient: new XClient({ logger }),
    logger,
    workspaceId: context.workspaces[0]!.id,
    workspaces: context.workspaces.map(({ id, name }) => ({ id, name })),
  };

  try {
    const reply = await runChosenChannel(commandContext, choice);
    await client.answerCallbackQuery(query.id).catch(() => {});

    if (query.message) {
      await client.editMessageText(
        String(query.message.chat.id),
        query.message.message_id,
        reply.text,
        TELEGRAM_PARSE_MODE,
        replyMarkupFor(reply, context.appBaseUrl),
      );
    }
  } catch (error) {
    logger.error('webhook.channel_choice_failed', {
      command: choice.command,
      workspaceId: choice.workspaceId,
      error: describeError(error),
    });
    await client
      .answerCallbackQuery(query.id, 'Something went wrong — try the command again.')
      .catch(() => {});
  }
}
