import { createHash } from 'node:crypto';
import { RSS_ITEM_ID_PREFIX } from '@/lib/sources/display';

/**
 * Who a feed entry is, from one fetch to the next.
 *
 * Feeds are untidy, so the key is the best thing the entry offers, in order:
 * its Atom `<id>`, its RSS `<guid>`, its link, and only failing all three a
 * hash of what it says. Never its position or when it was fetched: the same
 * entry seen tomorrow, moved down the feed, must be the same entry.
 */

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function entryStableKey(entry: {
  atomId?: string | null;
  guid?: string | null;
  link?: string | null;
  title?: string | null;
  publishedAt?: Date | null;
  text?: string | null;
}): string {
  const atomId = entry.atomId?.trim();
  if (atomId) return `id:${atomId}`;
  const guid = entry.guid?.trim();
  if (guid) return `guid:${guid}`;
  const link = entry.link?.trim();
  if (link) return `link:${link}`;

  const fields = [
    entry.title?.trim() ?? '',
    entry.publishedAt?.toISOString() ?? '',
    (entry.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000),
  ];
  return `hash:${sha256(fields.join('\n'))}`;
}

/**
 * The entry's id in `processed_posts.x_post_id`: `rss:<feed>:<entry>`, each a
 * hash.
 *
 * Compatibility debt, on purpose: `processed_posts` still has X's column
 * names, and an RSS item borrows them rather than the table being renamed for
 * a second platform. The prefix keeps it clear of X's numeric ids, the feed
 * part keeps two feeds apart, and both survive the source being removed and
 * added back — so the UNIQUE (workspace_id, x_post_id) goes on guarding
 * against duplicates for feeds too.
 */
export function rssItemId(feedUrl: string, stableKey: string): string {
  return `${RSS_ITEM_ID_PREFIX}${feedHash(feedUrl)}:${sha256(stableKey).slice(0, 32)}`;
}

/** A feed's URL, short and fixed-length — for item ids and `sync_state` keys. */
export function feedHash(feedUrl: string): string {
  return sha256(feedUrl).slice(0, 16);
}
