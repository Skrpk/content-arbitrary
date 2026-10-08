import type { SourcePlatform } from '@/db/schema';

/**
 * How a source, or a post from one, is named to people — and to Radar.
 *
 * An X account is `@NASA`; a feed is its title, `NASA Breaking News`, never
 * `@NASA Breaking News`. Everything shown about a source goes through here
 * rather than writing `@${username}` itself.
 */

/**
 * Where a feed item's id starts in `processed_posts.x_post_id`. X ids are
 * digits, so the prefix alone tells a feed item apart — which is how a row is
 * named correctly where only the post is at hand. See src/lib/rss/identity.ts.
 */
export const RSS_ITEM_ID_PREFIX = 'rss:';

export function isRssItemId(xPostId: string): boolean {
  return xPostId.startsWith(RSS_ITEM_ID_PREFIX);
}

/** A source's name: `@handle` on X, the feed's title for RSS. */
export function formatSourceLabel(platform: SourcePlatform, name: string): string {
  return platform === 'rss' ? name : `@${name.replace(/^@/, '')}`;
}

/**
 * The name of the source a stored post came from, or null when it was never
 * recorded. Its `x_author_username` holds an X handle or a feed's title.
 */
export function sourceLabelOfPost(xPostId: string, author: string | null): string | null {
  if (!author) return null;
  return formatSourceLabel(isRssItemId(xPostId) ? 'rss' : 'x', author);
}
