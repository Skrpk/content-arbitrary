import type { Logger } from '@/lib/logger';
import type { NormalizedPost } from '@/types';
import type { XClient } from '@/lib/x/client';
import { normalizePost } from '@/lib/x/normalize-post';
import type { XMedia } from '@/lib/x/schemas';

export interface GetNewPostsOptions {
  userId: string;
  fallbackUsername: string;
  sinceId?: string | null;
  fetchLimit: number;
  includeReplies: boolean;
  includeReposts: boolean;
  includeQuotes: boolean;
  logger: Logger;
}

export interface GetNewPostsResult {
  /** Media posts that passed every filter, ordered oldest → newest. */
  posts: NormalizedPost[];
  /** How many posts the API returned before filtering. */
  checked: number;
  /** Highest post id seen this run — becomes the next `since_id`. */
  newestId: string | null;
  skipped: { id: string; reason: string }[];
}

/**
 * Fetch the account's recent posts and reduce them to publishable media posts.
 *
 * Ordering matters: X returns newest-first, but we publish oldest-first so the
 * Telegram channel preserves the original chronology of a burst of posts.
 */
export async function getNewPosts(
  client: XClient,
  options: GetNewPostsOptions,
): Promise<GetNewPostsResult> {
  const response = await client.getUserTimeline({
    userId: options.userId,
    maxResults: options.fetchLimit,
    sinceId: options.sinceId ?? undefined,
    // Ask X to exclude what it can; we still re-check locally because `exclude`
    // does not cover quote posts and we want one consistent filtering path.
    excludeReplies: !options.includeReplies,
    excludeReposts: !options.includeReposts,
  });

  const rawPosts = response.data ?? [];
  const skipped: { id: string; reason: string }[] = [];

  const mediaByKey = new Map<string, XMedia>();
  for (const media of response.includes?.media ?? []) mediaByKey.set(media.media_key, media);

  const usersById = new Map((response.includes?.users ?? []).map((user) => [user.id, user]));

  const posts: NormalizedPost[] = [];
  let newestId: string | null = response.meta?.newest_id ?? null;

  for (const rawPost of rawPosts) {
    const username =
      (rawPost.author_id ? usersById.get(rawPost.author_id)?.username : undefined) ??
      options.fallbackUsername;

    const { post, unsupported } = normalizePost(rawPost, mediaByKey, username);

    if (post.isRepost && !options.includeReposts) {
      skipped.push({ id: post.id, reason: 'repost' });
      continue;
    }
    if (post.isReply && !options.includeReplies) {
      skipped.push({ id: post.id, reason: 'reply' });
      continue;
    }
    if (post.isQuote && !options.includeQuotes) {
      skipped.push({ id: post.id, reason: 'quote' });
      continue;
    }
    if (post.media.length === 0) {
      skipped.push({
        id: post.id,
        reason: unsupported.length > 0 ? `no usable media (${unsupported.join('; ')})` : 'no media',
      });
      continue;
    }

    if (unsupported.length > 0) {
      options.logger.warn('x.media_partially_unsupported', {
        xPostId: post.id,
        usable: post.media.length,
        problems: unsupported,
      });
    }

    posts.push(post);
  }

  // Snowflake ids are monotonic and numeric, so a length-then-lexicographic
  // comparison orders them correctly without touching Number's 53-bit ceiling.
  posts.sort((a, b) => compareSnowflake(a.id, b.id));

  if (!newestId && rawPosts.length > 0) {
    newestId = rawPosts.reduce(
      (max, post) => (compareSnowflake(post.id, max) > 0 ? post.id : max),
      rawPosts[0]!.id,
    );
  }

  return { posts, checked: rawPosts.length, newestId, skipped };
}

/** Compare two snowflake ids as big integers, safely. */
export function compareSnowflake(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
