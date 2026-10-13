import type { Source } from '@/db/schema';
import type { Database } from '@/lib/db';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { addSource } from '@/lib/sources/repository';
import { normalizeYouTubeChannel } from '@/lib/youtube/channel';
import type { YouTubeClient } from '@/lib/youtube/client';

/**
 * Add a public YouTube channel as a source — the one path for /addyoutube and
 * the Sources page alike.
 *
 * The channel is looked up once through the YouTube Data API (channels.list,
 * by handle or id — never search), so a name that is no channel is turned
 * away rather than stored to fail on every sync. It is stored by its channel
 * id, which never changes; its title is how it is shown, and its handle,
 * which can change, is not relied on. Nothing it has posted is sent: the
 * source follows the channel from now on.
 */

export type AddYouTubeResult =
  | { ok: true; source: Source; created: boolean; title: string; handle: string | null }
  | { ok: false; reason: string };

export const YOUTUBE_NOT_CONFIGURED = 'YouTube sources are not set up here: YOUTUBE_API_KEY is missing.';

export async function addYouTubeSource(
  db: Database,
  input: { channel: string; workspaceId: number; youtube: YouTubeClient | null; logger?: Logger },
): Promise<AddYouTubeResult> {
  const checked = normalizeYouTubeChannel(input.channel);
  if (!checked.ok) {
    return {
      ok: false,
      reason:
        checked.reason === 'video'
          ? 'That is a link to a video. Give the channel instead — its @handle or youtube.com/@handle link.'
          : checked.reason === 'empty'
            ? 'Give the channel’s @handle or its youtube.com link.'
            : 'That is not a YouTube channel’s @handle or link.',
    };
  }
  if (!input.youtube) return { ok: false, reason: YOUTUBE_NOT_CONFIGURED };

  let channel;
  try {
    channel = await input.youtube.getChannel(checked.channel);
  } catch (error) {
    input.logger?.warn('youtube.add_failed', { error: describeError(error) });
    return { ok: false, reason: `Could not look the channel up on YouTube: ${error instanceof Error ? error.message : 'unreachable'}` };
  }
  if (!channel) return { ok: false, reason: 'There is no YouTube channel by that name.' };

  const result = await addSource(db, {
    platform: 'youtube',
    externalId: channel.id,
    username: channel.title,
    workspaceId: input.workspaceId,
  });

  input.logger?.info('youtube.source_resolved', {
    workspaceId: input.workspaceId,
    sourceId: result.source.id,
    channelId: channel.id,
    handle: channel.handle,
    created: result.created,
  });
  return { ok: true, source: result.source, created: result.created, title: channel.title, handle: channel.handle };
}
