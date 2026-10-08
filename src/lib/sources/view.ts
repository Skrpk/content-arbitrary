import type { Source } from '@/db/schema';
import { formatSourceLabel } from '@/lib/sources/display';

/**
 * A source as the Mini App pages get it: only what they show. An X account's
 * id and the timestamps stay server-side; a feed's URL is shown — it is what
 * identifies a feed.
 */
export function sourceView(source: Source) {
  return {
    id: source.id,
    platform: source.platform,
    username: source.username,
    label: formatSourceLabel(source.platform, source.username),
    feedUrl: source.platform === 'rss' ? source.externalId : null,
    enabled: source.enabled,
    includeTextOnly: source.includeTextOnly,
  };
}
