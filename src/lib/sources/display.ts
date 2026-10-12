import type { SourcePlatform } from '@/db/schema';

/**
 * How a source, or a post from one, is named to people — and to Radar.
 *
 * An X account is `@NASA`; a feed is its title, `NASA Breaking News`, never
 * `@NASA Breaking News`; a Telegram channel is its username, `@durov`, as
 * Telegram itself names it. Everything shown about a source goes through here
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

/**
 * Where a Telegram channel post's id starts in `processed_posts.x_post_id`:
 * `tg:<channel>/<message id>`. See src/lib/telegram-channel/normalize.ts.
 */
export const TELEGRAM_POST_ID_PREFIX = 'tg:';

export function isTelegramPostId(xPostId: string): boolean {
  return xPostId.startsWith(TELEGRAM_POST_ID_PREFIX);
}

/** Which platform a stored post came from, told by its id alone. */
export function platformOfPostId(xPostId: string): SourcePlatform {
  if (isRssItemId(xPostId)) return 'rss';
  if (isTelegramPostId(xPostId)) return 'telegram';
  return 'x';
}

/** A source's name: `@handle` on X, `@username` for a Telegram channel, the feed's title for RSS. */
export function formatSourceLabel(platform: SourcePlatform, name: string): string {
  return platform === 'rss' ? name : `@${name.replace(/^@/, '')}`;
}

/**
 * The name of the source a stored post came from, or null when it was never
 * recorded. Its `x_author_username` holds an X handle, a channel's username
 * or a feed's title.
 */
export function sourceLabelOfPost(xPostId: string, author: string | null): string | null {
  if (!author) return null;
  return formatSourceLabel(platformOfPostId(xPostId), author);
}
