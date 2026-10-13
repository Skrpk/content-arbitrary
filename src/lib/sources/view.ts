import type { Source } from '@/db/schema';
import { formatSourceLabel } from '@/lib/sources/display';
import { channelUrl } from '@/lib/telegram-channel/username';
import { channelUrl as youtubeChannelUrl } from '@/lib/youtube/channel';

/**
 * A source as the Mini App pages get it: only what they show. An X account's
 * id and the timestamps stay server-side; a feed's URL is shown — it is what
 * identifies a feed — and a Telegram or YouTube channel's link, to open it.
 */

/** A channel's own page, for a Telegram or YouTube channel; null for an X account or a feed. */
export function sourceChannelUrl(platform: Source['platform'], externalId: string): string | null {
  if (platform === 'telegram') return channelUrl(externalId);
  if (platform === 'youtube') return youtubeChannelUrl(externalId);
  return null;
}
export function sourceView(source: Source) {
  return {
    id: source.id,
    platform: source.platform,
    username: source.username,
    label: formatSourceLabel(source.platform, source.username),
    feedUrl: source.platform === 'rss' ? source.externalId : null,
    channelUrl: sourceChannelUrl(source.platform, source.externalId),
    enabled: source.enabled,
    includeTextOnly: source.includeTextOnly,
  };
}
