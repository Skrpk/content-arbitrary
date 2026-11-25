import { and, eq, inArray } from 'drizzle-orm';
import { workspaces, type Workspace } from '@/db/schema';
import type { Database } from '@/lib/db';
import { describeError } from '@/lib/errors';
import type { TelegramClient } from '@/lib/telegram/client';

/**
 * A channel's preview channel, as Settings sets it: where Send to preview
 * puts a post (src/app/api/telegram/webapp/preview).
 *
 * What the reviewer types — a public channel's @username, its t.me link, or
 * a private channel's id (-100…) — is looked up in Telegram before it is kept,
 * and kept by its id: a username can change hands. The bot must be in it and
 * able to post; it may not be the channel itself.
 */

export type PreviewChannelCheck = { ok: true; chatId: string; title: string } | { ok: false; error: string };

/** The chat a typed reference names, as Telegram takes it: `@name`, or a numeric id. */
export function previewChannelRef(input: string): string | null {
  const value = input.trim();
  const link = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/([A-Za-z][A-Za-z0-9_]{3,31})\/?$/i.exec(value);
  if (link) return `@${link[1]}`;
  if (/^@?[A-Za-z][A-Za-z0-9_]{3,31}$/.test(value)) return value.startsWith('@') ? value : `@${value}`;
  if (/^-?\d{5,20}$/.test(value)) return value;
  return null;
}

export async function checkPreviewChannel(
  client: Pick<TelegramClient, 'getMe' | 'getChat' | 'getChatMember'>,
  input: { value: string; channelChatId: string | null },
): Promise<PreviewChannelCheck> {
  const ref = previewChannelRef(input.value);
  if (!ref) return { ok: false, error: 'Give the channel’s @username, its t.me link, or its id (-100…).' };

  let chat: Awaited<ReturnType<TelegramClient['getChat']>>;
  try {
    chat = await client.getChat(ref);
  } catch (error) {
    return { ok: false, error: `Telegram does not show that chat to the bot: ${describeError(error).slice(0, 200)}. Add the bot to it first.` };
  }
  const chatId = String(chat.id);
  const title = chat.title ?? (chat.username ? `@${chat.username}` : chatId);
  if (input.channelChatId && chatId === input.channelChatId) {
    return { ok: false, error: 'That is the channel itself. The preview channel is another one, where nobody but you sees the post.' };
  }

  const me = await client.getMe();
  let member: Awaited<ReturnType<TelegramClient['getChatMember']>>;
  try {
    member = await client.getChatMember(chatId, me.id);
  } catch (error) {
    return { ok: false, error: `Could not check the bot in ${title}: ${describeError(error).slice(0, 200)}` };
  }
  const canPost =
    chat.type === 'channel'
      ? member.status === 'creator' || (member.status === 'administrator' && member.can_post_messages !== false)
      : ['creator', 'administrator', 'member'].includes(member.status);
  if (!canPost) {
    return {
      ok: false,
      error:
        chat.type === 'channel'
          ? `The bot is not an administrator who may post in ${title}. Make it one, then try again.`
          : `The bot is not a member of ${title}. Add it, then try again.`,
    };
  }
  return { ok: true, chatId, title };
}

/** Set or clear a channel's preview channel, only within the reviewer's channels. */
export async function setPreviewChannel(
  db: Database,
  input: { workspaceId: number; reviewerWorkspaceIds: number[]; chatId: string | null },
): Promise<Workspace | null> {
  if (!input.reviewerWorkspaceIds.includes(input.workspaceId)) return null;
  const [updated] = await db
    .update(workspaces)
    .set({ previewChatId: input.chatId, updatedAt: new Date() })
    .where(and(eq(workspaces.id, input.workspaceId), inArray(workspaces.id, input.reviewerWorkspaceIds)))
    .returning();
  return updated ?? null;
}

/** A preview channel's name, for Settings; its id when Telegram cannot say. */
export async function previewChannelTitle(client: Pick<TelegramClient, 'getChat'>, chatId: string): Promise<string> {
  try {
    const chat = await client.getChat(chatId);
    return chat.title ?? (chat.username ? `@${chat.username}` : chatId);
  } catch {
    return chatId;
  }
}
