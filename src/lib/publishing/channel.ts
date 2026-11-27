import { track } from '@/lib/analytics/track';
import { and, eq, isNull } from 'drizzle-orm';
import { workspaces, type Workspace } from '@/db/schema';
import type { Database } from '@/lib/db';
import { z } from 'zod';
import { AppError, describeError, TelegramApiError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { CHANNEL_NOT_CONNECTED } from '@/lib/publishing/codes';
import type { TelegramClient } from '@/lib/telegram/client';

/**
 * Whether Zmistik may publish to a workspace's channel.
 *
 * Someone who onboards their channel in the bot gets the whole review — the
 * queue, the digest, the editor, Send to preview — before anyone has shown
 * that they run that channel. So publishing waits for the channel to be
 * connected: the bot made an admin there that can post, by a person who can
 * post there too. Until then every path to the channel refuses, whatever is
 * approved, scheduled or set to publish without review.
 *
 * Operator workspaces are connected from the start (the column's default).
 */

export { CHANNEL_NOT_CONNECTED };

/** What a refusal tells the person: the same words wherever they pressed. */
export const CHANNEL_NOT_CONNECTED_MESSAGE = 'Set up the channel your posts go to first: Settings → Publishing channel.';

export class ChannelNotConnectedError extends AppError {
  constructor(workspaceId: number) {
    super(`workspace ${workspaceId}: the channel is not connected, so nothing is published to it`, {
      transient: false,
      code: CHANNEL_NOT_CONNECTED,
    });
  }
}

export function channelConnected(workspace: Pick<Workspace, 'channelVerifiedAt'>): boolean {
  return workspace.channelVerifiedAt !== null;
}

export type ChannelCheck =
  | { ok: true }
  | { ok: false; reason: 'bot_not_admin' | 'bot_cannot_post' | 'user_not_admin' | 'channel_unreachable' };

/** What each failed check tells the person, and what to do about it. */
export const CHANNEL_CHECK_MESSAGES: Record<Exclude<ChannelCheck, { ok: true }>['reason'], string> = {
  bot_not_admin: 'The bot is not an admin of the channel yet. Add it as an admin, then check again.',
  bot_cannot_post: 'The bot is an admin but cannot post. Turn on “Post messages” for it, then check again.',
  user_not_admin: 'You are not an admin of this channel who can post, so it cannot be connected from your account.',
  channel_unreachable: 'Telegram could not find the channel for the bot. Add the bot as an admin, then check again.',
};

/**
 * Whether the bot can post to the channel, and the person — by their
 * Telegram id — is its creator or an admin who can post. Both, so nobody
 * connects a channel that is not theirs just because the bot is in it.
 */
export async function checkChannelConnection(input: {
  client: Pick<TelegramClient, 'getMe' | 'getChatMember'>;
  chatId: string;
  userTelegramId: string;
}): Promise<ChannelCheck> {
  const { client, chatId } = input;
  const me = await client.getMe();

  let bot;
  try {
    bot = await client.getChatMember(chatId, me.id);
  } catch (error) {
    // Not in the channel, or the channel is not one it can see.
    if (error instanceof TelegramApiError && !error.transient) return { ok: false, reason: 'channel_unreachable' };
    throw error;
  }
  if (bot.status !== 'administrator') return { ok: false, reason: 'bot_not_admin' };
  if (bot.can_post_messages !== true) return { ok: false, reason: 'bot_cannot_post' };

  const userId = Number(input.userTelegramId);
  if (!Number.isSafeInteger(userId)) return { ok: false, reason: 'user_not_admin' };
  let user;
  try {
    user = await client.getChatMember(chatId, userId);
  } catch (error) {
    if (error instanceof TelegramApiError && !error.transient) return { ok: false, reason: 'user_not_admin' };
    throw error;
  }
  const userCanPost = user.status === 'creator' || (user.status === 'administrator' && user.can_post_messages === true);
  return userCanPost ? { ok: true } : { ok: false, reason: 'user_not_admin' };
}

/**
 * Record the channel as connected. Returns the row when this call connected
 * it, null when it already was (or the workspace is gone).
 */
export async function markChannelConnected(db: Database, workspaceId: number, at = new Date()): Promise<Workspace | null> {
  const rows = await db
    .update(workspaces)
    .set({ channelVerifiedAt: at, updatedAt: at })
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.channelVerifiedAt)))
    .returning();
  return rows[0] ?? null;
}

/** Workspaces with this channel that are not connected yet, for the bot's own admin rights changing there. */
export async function unconnectedWorkspacesForChannel(db: Database, chatId: string): Promise<Workspace[]> {
  return db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.telegramChatId, chatId), isNull(workspaces.channelVerifiedAt)));
}

/** What Telegram sends the bot when its own rights in a chat change (`my_chat_member`). */
export interface BotMembershipChange {
  chat: { id: number; type?: string };
  from: { id: number };
  new_chat_member: { status: string; can_post_messages?: boolean };
}

/**
 * The bot was made an admin of a channel: connect every workspace with that
 * channel that is not connected yet, when the person who did it reviews it
 * and passes the same check as Settings' Check button — and tell them. Never
 * throws: a failure here only means they press Check themselves.
 */
export async function connectOnBotPromotion(input: {
  db: Database;
  client: Pick<TelegramClient, 'getMe' | 'getChatMember' | 'call'>;
  change: BotMembershipChange;
  /** The Telegram ids of who may review a workspace: its named reviewer and members. */
  reviewersOf: (workspace: Workspace) => Promise<string[]>;
  logger: Logger;
}): Promise<number[]> {
  const { db, client, change, logger } = input;
  if (change.chat.type !== 'channel') return [];
  if (change.new_chat_member.status !== 'administrator' || change.new_chat_member.can_post_messages !== true) return [];

  const connected: number[] = [];
  try {
    const chatId = String(change.chat.id);
    const userTelegramId = String(change.from.id);
    for (const workspace of await unconnectedWorkspacesForChannel(db, chatId)) {
      if (!(await input.reviewersOf(workspace)).includes(userTelegramId)) continue;
      const check = await checkChannelConnection({ client, chatId, userTelegramId });
      if (!check.ok) {
        logger.info('channel.auto_connect_refused', { workspaceId: workspace.id, reason: check.reason });
        continue;
      }
      if (!(await markChannelConnected(db, workspace.id))) continue;
      connected.push(workspace.id);
      logger.info('webapp.channel_connected', { workspaceId: workspace.id, via: 'my_chat_member' });
      await track(db, 'channel.connected', { telegramUserId: userTelegramId, workspaceId: workspace.id, props: { via: 'my_chat_member' } }, logger);
      await client
        .call(
          'sendMessage',
          {
            chat_id: userTelegramId,
            text: `✅ ${workspace.name}: channel connected. Posts can now be published and scheduled from Zmistik.`,
          },
          z.object({ message_id: z.number() }),
        )
        .catch((error: unknown) => logger.warn('channel.connected_notice_failed', { error: describeError(error) }));
    }
  } catch (error) {
    logger.warn('channel.auto_connect_failed', { chatId: change.chat.id, error: describeError(error) });
  }
  return connected;
}
