import type { Logger } from '@/lib/logger';
import type { NormalizedPost } from '@/types';
import type { XClient } from '@/lib/x/client';
import { normalizePost } from '@/lib/x/normalize-post';
import type { XMedia, XTimelineResponse } from '@/lib/x/schemas';

/**
 * Most pages read back towards the cursor in one run. Each page is
 * `fetchLimit` posts, and every post read is billed, so this bounds what one
 * busy account can cost a single run.
 */
export const X_MAX_PAGES = 5;

export interface GetNewPostsOptions {
  userId: string;
  fallbackUsername: string;
  sinceId?: string | null;
  fetchLimit: number;
  includeReplies: boolean;
  includeReposts: boolean;
  includeQuotes: boolean;
  /** Keep posts that have no media at all, to be sent as text. */
  includeTextOnly: boolean;
  logger: Logger;
}

export interface GetNewPostsResult {
  /** Posts that passed every filter, ordered oldest → newest. */
  posts: NormalizedPost[];
  /** How many posts the API returned before filtering. */
  checked: number;
  /** Highest post id seen this run — becomes the next `since_id`. */
  newestId: string | null;
  skipped: { id: string; reason: string }[];
  /** Pages read. More than one only when the cursor was further back than a page. */
  pages: number;
  /**
   * The account has more posts since the cursor than X_MAX_PAGES pages hold:
   * the oldest of them were not read and will not be.
   */
  overflow: boolean;
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
  const { response, pages, overflow } = await readSinceCursor(client, options);

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
    // Media that exists but cannot be sent is never published as text alone:
    // the post would go out without the very thing that made it a post.
    if (post.media.length === 0 && unsupported.length > 0) {
      skipped.push({ id: post.id, reason: `no usable media (${unsupported.join('; ')})` });
      continue;
    }
    if (post.media.length === 0 && (!options.includeTextOnly || post.text === '')) {
      skipped.push({ id: post.id, reason: post.text === '' ? 'no media and no text' : 'no media' });
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

  return { posts, checked: rawPosts.length, newestId, skipped, pages, overflow };
}

/**
 * Read everything since the cursor, newest page first.
 *
 * X returns the newest posts first, a page at a time. When more posts arrived
 * since the cursor than one page holds, the oldest of them — the very ones to
 * publish next — are on later pages, and reading only the first would skip
 * them for good. So while X reports more, read on, asking for posts older than
 * the oldest one so far (`until_id`), down to the cursor (`since_id`).
 *
 * Without a cursor — a source's first run — only the first page is read, on
 * purpose: a new source starts from its latest posts, not its history.
 */
async function readSinceCursor(
  client: XClient,
  options: GetNewPostsOptions,
): Promise<{ response: XTimelineResponse; pages: number; overflow: boolean }> {
  const query = {
    userId: options.userId,
    maxResults: options.fetchLimit,
    sinceId: options.sinceId ?? undefined,
    // Ask X to exclude what it can; we still re-check locally because `exclude`
    // does not cover quote posts and we want one consistent filtering path.
    excludeReplies: !options.includeReplies,
    excludeReposts: !options.includeReposts,
  };

  const first = await client.getUserTimeline(query);
  const data = [...(first.data ?? [])];
  const media = [...(first.includes?.media ?? [])];
  const users = [...(first.includes?.users ?? [])];

  let pages = 1;
  let last = first;
  while (options.sinceId && last.meta?.next_token && (last.data?.length ?? 0) > 0) {
    if (pages >= X_MAX_PAGES) {
      options.logger.warn('sync.window_overflow', {
        sinceId: options.sinceId,
        oldestRead: last.meta?.oldest_id ?? null,
        pages,
        postsRead: data.length,
      });
      return { response: merged(first, data, media, users), pages, overflow: true };
    }

    const oldest = last.data!.reduce(
      (min, post) => (compareSnowflake(post.id, min) < 0 ? post.id : min),
      last.data![0]!.id,
    );
    last = await client.getUserTimeline({ ...query, untilId: oldest });
    pages += 1;
    data.push(...(last.data ?? []));
    media.push(...(last.includes?.media ?? []));
    users.push(...(last.includes?.users ?? []));
  }

  if (pages > 1) {
    options.logger.info('x.read_back_to_cursor', { sinceId: options.sinceId, pages, postsRead: data.length });
  }
  return { response: merged(first, data, media, users), pages, overflow: false };
}

function merged(
  first: XTimelineResponse,
  data: NonNullable<XTimelineResponse['data']>,
  media: NonNullable<NonNullable<XTimelineResponse['includes']>['media']>,
  users: NonNullable<NonNullable<XTimelineResponse['includes']>['users']>,
): XTimelineResponse {
  return {
    ...first,
    data,
    includes: { media, users },
    // The newest post is on the first page; keep its id as the window's top.
    meta: { ...first.meta, result_count: data.length },
  };
}

/** Compare two snowflake ids as big integers, safely. */
export function compareSnowflake(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
