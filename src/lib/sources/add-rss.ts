import type { Source } from '@/db/schema';
import type { Database } from '@/lib/db';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { fetchFeed, type FetchFeedOptions } from '@/lib/rss/client';
import { parseFeed } from '@/lib/rss/parser';
import { normalizeFeedUrl } from '@/lib/rss/url';
import { addSource } from '@/lib/sources/repository';

/**
 * Add an RSS / Atom feed as a source — the one path for /addrss and the
 * Settings page alike.
 *
 * The feed is fetched and parsed once first, so a URL that is not a feed is
 * turned away rather than stored to fail on every sync. Nothing it holds is
 * sent: the source's first sync records it all as backlog.
 */

export type AddRssResult =
  | { ok: true; source: Source; created: boolean; title: string; entries: number }
  | { ok: false; reason: string };

export const NOT_A_FEED = 'This URL does not appear to be a valid RSS or Atom feed.';

export async function addRssSource(
  db: Database,
  input: { url: string; workspaceId: number; feedFetch?: FetchFeedOptions; logger?: Logger },
): Promise<AddRssResult> {
  const checked = normalizeFeedUrl(input.url);
  if (!checked.ok) return { ok: false, reason: checked.reason };

  let title: string;
  let entries: number;
  try {
    const fetched = await fetchFeed(checked.url, input.feedFetch);
    const feed = parseFeed(fetched.xml, fetched.finalUrl);
    title = feed.title ?? new URL(checked.url).hostname;
    entries = feed.entries.length;
  } catch (error) {
    input.logger?.warn('rss.add_failed', { feedHost: new URL(checked.url).hostname, error: describeError(error) });
    return { ok: false, reason: `${NOT_A_FEED} (${error instanceof Error ? error.message : 'unreadable'})` };
  }

  const result = await addSource(db, {
    platform: 'rss',
    externalId: checked.url,
    username: title,
    workspaceId: input.workspaceId,
  });

  input.logger?.info('rss.source_added', {
    workspaceId: input.workspaceId,
    sourceId: result.source.id,
    feedHost: new URL(checked.url).hostname,
    created: result.created,
    entries,
  });
  return { ok: true, source: result.source, created: result.created, title, entries };
}
