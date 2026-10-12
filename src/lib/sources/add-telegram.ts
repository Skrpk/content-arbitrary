import type { Source } from '@/db/schema';
import type { Database } from '@/lib/db';
import { ChannelPageError, describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { addSource } from '@/lib/sources/repository';
import { fetchChannelPage, type FetchChannelOptions } from '@/lib/telegram-channel/client';
import { normalizeChannelUsername } from '@/lib/telegram-channel/username';

/**
 * Add a public Telegram channel as a source — the one path for /addtelegram
 * and the Settings page alike.
 *
 * Its public page is read once first, so a name that is not a public
 * channel — a private one, a person, a group, a typo — is turned away rather
 * than stored to fail on every sync. Nothing on the page is sent: the source
 * follows the channel from now on.
 */

export type AddTelegramResult =
  | { ok: true; source: Source; created: boolean; title: string }
  | { ok: false; reason: string };

export const NOT_A_PUBLIC_CHANNEL =
  'That is not a public Telegram channel. Private channels, groups, people and bots cannot be followed — ' +
  'only channels with a public @username.';

export async function addTelegramSource(
  db: Database,
  input: { channel: string; workspaceId: number; channelFetch?: FetchChannelOptions; logger?: Logger },
): Promise<AddTelegramResult> {
  const checked = normalizeChannelUsername(input.channel);
  if (!checked.ok) {
    return {
      ok: false,
      reason:
        checked.reason === 'private'
          ? 'That is an invite link to a private channel. Only public channels can be followed.'
          : checked.reason === 'empty'
            ? 'Give the channel’s @username or its t.me link.'
            : 'That is not a Telegram channel username or t.me link.',
    };
  }
  const username = checked.username;

  let title: string;
  try {
    const page = await fetchChannelPage(username, input.channelFetch);
    // A page with no channel header and no posts is not a channel's.
    if (!page.title && page.posts.length === 0) return { ok: false, reason: NOT_A_PUBLIC_CHANNEL };
    title = page.title ?? `@${username}`;
  } catch (error) {
    input.logger?.warn('telegram_channel.add_failed', { channel: username, error: describeError(error) });
    if (error instanceof ChannelPageError && error.code === 'channel_no_preview') {
      return { ok: false, reason: NOT_A_PUBLIC_CHANNEL };
    }
    return {
      ok: false,
      reason: `Could not read the channel’s page: ${error instanceof Error ? error.message : 'unreadable'}`,
    };
  }

  const result = await addSource(db, {
    platform: 'telegram',
    externalId: username,
    username,
    workspaceId: input.workspaceId,
  });

  input.logger?.info('telegram_channel.source_added', {
    workspaceId: input.workspaceId,
    sourceId: result.source.id,
    channel: username,
    created: result.created,
  });
  return { ok: true, source: result.source, created: result.created, title };
}
