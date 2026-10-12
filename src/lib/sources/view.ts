import type { Source } from '@/db/schema';
import { formatSourceLabel } from '@/lib/sources/display';
import { channelUrl } from '@/lib/telegram-channel/username';

/**
 * A source as the Mini App pages get it: only what they show. An X account's
 * id and the timestamps stay server-side; a feed's URL is shown — it is what
 * identifies a feed — and a Telegram channel's link, to open it.
 */
export function sourceView(source: Source) {
  return {
    id: source.id,
    platform: source.platform,
    username: source.username,
    label: formatSourceLabel(source.platform, source.username),
    feedUrl: source.platform === 'rss' ? source.externalId : null,
    channelUrl: source.platform === 'telegram' ? channelUrl(source.externalId) : null,
    enabled: source.enabled,
    includeTextOnly: source.includeTextOnly,
  };
}
