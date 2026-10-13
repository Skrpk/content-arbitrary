import { and, desc, eq, lt, ne } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import { processedPosts, storyPosts, type HistoryRetrievalRecord, type RejectionReason } from '@/db/schema';
import { APPROVED_STATUSES } from '@/lib/radar/repository';
import { isRssItemId } from '@/lib/sources/display';

/**
 * A post's story as it stood when the post arrived — for Radar: how many
 * other sources had reported the same event, and what the editor had done
 * with their posts by then. Only what came before: posts that arrived later,
 * and decisions made later, are not seen, so a backfill measures prediction.
 */

/** The earlier posts shown; the count covers them all. */
export const STORY_CONTEXT_POSTS_MAX = 8;

export interface StoryContextPost {
  processedPostId: number;
  sourceUsername: string | null;
  /** 'rss' when `sourceUsername` is a feed's title rather than an X handle. */
  sourcePlatform?: 'rss';
  /** How long before the new post it arrived. */
  hoursBefore: number;
  /** What the editor had done with it by the time the new post arrived. */
  decision: 'published' | 'rejected' | 'undecided';
  rejectionReason: RejectionReason | null;
  /** From the new post's own source. */
  sameSource: boolean;
  text: string | null;
}

export interface StoryContext {
  storyId: number;
  /** The earlier posts of the story, of any source. */
  earlierPosts: number;
  /** The sources among them other than the new post's own. */
  otherSources: number;
  /** The most recent earlier posts, newest first. */
  posts: StoryContextPost[];
}

/** The story so far for a post, as of `before`; null when the post was never placed in one. */
export async function loadStoryContext(
  db: Database,
  input: { processedPostId: number; before: Date },
): Promise<StoryContext | null> {
  const [own] = await db
    .select({
      storyId: storyPosts.storyId,
      arrivedAt: processedPosts.createdAt,
      sourceUsername: processedPosts.xAuthorUsername,
    })
    .from(storyPosts)
    .innerJoin(processedPosts, eq(processedPosts.id, storyPosts.processedPostId))
    .where(eq(storyPosts.processedPostId, input.processedPostId));
  if (!own) return null;

  const rows = await db
    .select({
      processedPostId: processedPosts.id,
      xPostId: processedPosts.xPostId,
      sourceUsername: processedPosts.xAuthorUsername,
      arrivedAt: processedPosts.createdAt,
      status: processedPosts.status,
      reviewedAt: processedPosts.reviewedAt,
      rejectionReason: processedPosts.rejectionReason,
      text: processedPosts.sourceText,
    })
    .from(storyPosts)
    .innerJoin(processedPosts, eq(processedPosts.id, storyPosts.processedPostId))
    .where(
      and(
        eq(storyPosts.storyId, own.storyId),
        ne(processedPosts.id, input.processedPostId),
        lt(processedPosts.createdAt, own.arrivedAt),
      ),
    )
    .orderBy(desc(processedPosts.createdAt), desc(processedPosts.id));

  const decidedBefore = (reviewedAt: Date | null) => reviewedAt !== null && reviewedAt < input.before;
  const posts = rows.map((row): StoryContextPost => {
    const published = (APPROVED_STATUSES as readonly string[]).includes(row.status) && decidedBefore(row.reviewedAt);
    const rejected = row.status === 'rejected' && decidedBefore(row.reviewedAt);
    return {
      processedPostId: row.processedPostId,
      sourceUsername: row.sourceUsername,
      ...(isRssItemId(row.xPostId) ? { sourcePlatform: 'rss' as const } : {}),
      hoursBefore: (own.arrivedAt.getTime() - row.arrivedAt.getTime()) / 3_600_000,
      decision: published ? 'published' : rejected ? 'rejected' : 'undecided',
      rejectionReason: rejected ? row.rejectionReason : null,
      sameSource: row.sourceUsername === own.sourceUsername,
      text: row.text,
    };
  });

  return {
    storyId: own.storyId,
    earlierPosts: posts.length,
    otherSources: new Set(posts.filter((post) => !post.sameSource).map((post) => post.sourceUsername)).size,
    posts: posts.slice(0, STORY_CONTEXT_POSTS_MAX),
  };
}

/** What a prompt was shown of the story, as recorded with its score. */
export function storyRecord(context: StoryContext | null): HistoryRetrievalRecord['story'] {
  return context
    ? {
        storyId: context.storyId,
        earlierPosts: context.earlierPosts,
        otherSources: context.otherSources,
        posts: context.posts.map((post) => ({ id: post.processedPostId, decision: post.decision })),
      }
    : null;
}
