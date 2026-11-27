import { ChannelPageError, TelegramApiError } from '@/lib/errors';
import type { TelegramClient } from '@/lib/telegram/client';
import { fetchChannelPage, type FetchChannelOptions } from '@/lib/telegram-channel/client';
import { normalizeChannelUsername } from '@/lib/telegram-channel/username';

/**
 * Whether what someone sent is a public channel Zmistik can read (§6): a
 * username, which the Bot API knows as a channel — its id and title — and
 * whose web page has posts. Nothing is written.
 */

export type ChannelValidation =
  | { ok: true; username: string; chatId: string; title: string }
  | { ok: false; reason: 'invalid' | 'private' | 'not_a_channel' | 'no_posts' | 'unavailable' };

export async function validateChannel(
  input: string,
  deps: { client: Pick<TelegramClient, 'getChat'> } & FetchChannelOptions,
): Promise<ChannelValidation> {
  const name = normalizeChannelUsername(input);
  if (!name.ok) return { ok: false, reason: name.reason === 'private' ? 'private' : 'invalid' };

  let chat;
  try {
    chat = await deps.client.getChat(`@${name.username}`);
  } catch (error) {
    // No such chat, or one the bot may not see: not a public channel.
    if (error instanceof TelegramApiError && !error.transient) return { ok: false, reason: 'not_a_channel' };
    return { ok: false, reason: 'unavailable' };
  }
  if (chat.type !== 'channel') return { ok: false, reason: 'not_a_channel' };

  try {
    const page = await fetchChannelPage(name.username, deps);
    if (page.posts.length === 0) return { ok: false, reason: 'no_posts' };
  } catch (error) {
    if (error instanceof ChannelPageError && !error.transient) return { ok: false, reason: 'not_a_channel' };
    return { ok: false, reason: 'unavailable' };
  }

  return { ok: true, username: name.username, chatId: String(chat.id), title: chat.title?.trim() || `@${name.username}` };
}
