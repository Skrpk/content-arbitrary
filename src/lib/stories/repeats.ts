import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '@/lib/db';
import { processedPosts, storyPosts, type PostStatus } from '@/db/schema';

/**
 * A repeat: a post its source has sent before, word for word or nearly — some
 * accounts post the same text and picture again every day or two. Told by
 * the story clustering: the nearest earlier post is from the same source and
 * all but identical. Shown to the reviewer with what became of the earlier
 * copy; nothing is decided for them.
 *
 * On VECTOR's first week, 50 posts were repeats at 0.97 or above — 47 of
 * them rejected — and none came from another source at that level.
 */
export const REPEAT_SIMILARITY = 0.97;

export interface Repeat {
  /** The earlier copy: the nearest, which may itself be a repeat of one before it. */
  ofPostId: number;
  arrivedAt: Date;
  status: PostStatus;
}

/** The repeats among `processedPostIds`, each with its earlier copy; a post that is none is absent. */
export async function findRepeats(db: Database, processedPostIds: number[]): Promise<Map<number, Repeat>> {
  const repeats = new Map<number, Repeat>();
  if (processedPostIds.length === 0) return repeats;

  const post = alias(processedPosts, 'post');
  const earlier = alias(processedPosts, 'earlier');
  const rows = await db
    .select({
      processedPostId: storyPosts.processedPostId,
      ofPostId: earlier.id,
      arrivedAt: earlier.createdAt,
      status: earlier.status,
    })
    .from(storyPosts)
    .innerJoin(post, eq(post.id, storyPosts.processedPostId))
    .innerJoin(earlier, eq(earlier.id, storyPosts.nearestPostId))
    .where(
      and(
        inArray(storyPosts.processedPostId, processedPostIds),
        gte(storyPosts.similarity, REPEAT_SIMILARITY),
        // The source as the reviewer knows it: the account, channel or feed.
        sql`${post.xAuthorUsername} = ${earlier.xAuthorUsername}`,
      ),
    );
  for (const { processedPostId, ...repeat } of rows) repeats.set(processedPostId, repeat);
  return repeats;
}

export async function findRepeat(db: Database, processedPostId: number): Promise<Repeat | null> {
  return (await findRepeats(db, [processedPostId])).get(processedPostId) ?? null;
}

/** What became of the earlier copy, as the reviewer would put it. */
export function repeatOutcome(status: PostStatus): string {
  switch (status) {
    case 'published':
    case 'scheduled':
      return 'published';
    case 'rejected':
      return 'rejected';
    case 'awaiting_approval':
      return 'still in review';
    default:
      return 'not published';
  }
}

/** `🔁 Repeat of a post from 10 Oct · rejected`, as plain text. */
export function formatRepeatNote(repeat: Repeat | null): string | null {
  if (!repeat) return null;
  const day = repeat.arrivedAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `🔁 Repeat of a post from ${day} · ${repeatOutcome(repeat.status)}`;
}
