import { and, asc, eq, gte, lt, ne, sql } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import { processedPosts, radarCandidateEmbeddings, stories, storyPosts } from '@/db/schema';
import { advisoryLockKey } from '@/lib/sync/locks';

/**
 * Story clustering: which posts, from whatever source, report the same event.
 *
 * A post is compared with the posts that arrived in the window before it, by
 * the vector Radar's retrieval already made of it — no extra embedding call.
 * When the nearest is similar enough, the post joins that post's story;
 * otherwise it starts one. One link is enough, so a story can grow from day
 * to day as long as each new post is close to one in the window.
 *
 * On VECTOR's first week, a nearest post at 0.75 or above was almost always
 * the same event told by another account (a crew's return, a reentry video,
 * an obituary); between 0.70 and 0.75 about half were, and below that it was
 * mostly the same subject — another galaxy, another nebula.
 */
export const STORY_SIMILARITY_THRESHOLD = 0.75;
/** How far back a post looks for its story. */
export const STORY_WINDOW_HOURS = 48;

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** The database, or a transaction in it — the clustering script runs in one, to roll a trial back. */
export type Db = Database | Transaction;

export interface StoryPlacement {
  storyId: number;
  /** joined: an earlier post's story; started: a story of its own; existing: placed before. */
  outcome: 'joined' | 'started' | 'existing';
  nearestPostId: number | null;
  similarity: number | null;
}

/**
 * Put a post in its story, once. Null when the post has no vector for
 * `model` — no text and no understood image, or never searched with — and so
 * nothing to compare.
 */
export async function placeInStory(
  db: Db,
  input: { workspaceId: number; processedPostId: number; model: string; threshold?: number; windowHours?: number },
): Promise<StoryPlacement | null> {
  const threshold = input.threshold ?? STORY_SIMILARITY_THRESHOLD;
  const windowMs = (input.windowHours ?? STORY_WINDOW_HOURS) * 3_600_000;

  return db.transaction(async (tx) => {
    // One post at a time per workspace, so two close posts cannot both start a story.
    await tx.execute(sql`select pg_advisory_xact_lock(${advisoryLockKey(`stories:${input.workspaceId}`)})`);

    const [placed] = await tx.select().from(storyPosts).where(eq(storyPosts.processedPostId, input.processedPostId));
    if (placed) {
      return {
        storyId: placed.storyId,
        outcome: 'existing' as const,
        nearestPostId: placed.nearestPostId,
        similarity: placed.similarity,
      };
    }

    const [post] = await tx
      .select({ embedding: radarCandidateEmbeddings.embedding, arrivedAt: processedPosts.createdAt })
      .from(radarCandidateEmbeddings)
      .innerJoin(processedPosts, eq(processedPosts.id, radarCandidateEmbeddings.processedPostId))
      .where(
        and(
          eq(radarCandidateEmbeddings.processedPostId, input.processedPostId),
          eq(radarCandidateEmbeddings.model, input.model),
          eq(processedPosts.workspaceId, input.workspaceId),
        ),
      );
    if (!post) return null;

    const query = sql`${`[${post.embedding.join(',')}]`}::vector`;
    const distance = sql`${radarCandidateEmbeddings.embedding} <=> ${query}`;
    // Only posts already in a story: every post that could be is placed as it arrives.
    const [nearest] = await tx
      .select({
        processedPostId: processedPosts.id,
        storyId: storyPosts.storyId,
        similarity: sql<number>`1 - (${distance})`.mapWith(Number),
      })
      .from(radarCandidateEmbeddings)
      .innerJoin(processedPosts, eq(processedPosts.id, radarCandidateEmbeddings.processedPostId))
      .innerJoin(storyPosts, eq(storyPosts.processedPostId, processedPosts.id))
      .where(
        and(
          eq(processedPosts.workspaceId, input.workspaceId),
          eq(radarCandidateEmbeddings.model, input.model),
          eq(radarCandidateEmbeddings.dimensions, post.embedding.length),
          ne(processedPosts.id, input.processedPostId),
          lt(processedPosts.createdAt, post.arrivedAt),
          gte(processedPosts.createdAt, new Date(post.arrivedAt.getTime() - windowMs)),
        ),
      )
      .orderBy(distance, asc(processedPosts.id))
      .limit(1);

    const joins = nearest !== undefined && nearest.similarity >= threshold;
    const storyId = joins
      ? nearest.storyId
      : (await tx.insert(stories).values({ workspaceId: input.workspaceId }).returning({ id: stories.id }))[0]!.id;

    await tx.insert(storyPosts).values({
      processedPostId: input.processedPostId,
      storyId,
      nearestPostId: nearest?.processedPostId ?? null,
      similarity: nearest?.similarity ?? null,
      threshold,
      embeddingModel: input.model,
    });

    return {
      storyId,
      outcome: joins ? ('joined' as const) : ('started' as const),
      nearestPostId: nearest?.processedPostId ?? null,
      similarity: nearest?.similarity ?? null,
    };
  });
}

/** A workspace's posts with a vector for `model` and no story yet, in the order they arrived. */
export async function loadUnplacedPosts(db: Db, input: { workspaceId: number; model: string }): Promise<number[]> {
  const rows = await db
    .select({ id: processedPosts.id })
    .from(radarCandidateEmbeddings)
    .innerJoin(processedPosts, eq(processedPosts.id, radarCandidateEmbeddings.processedPostId))
    .leftJoin(storyPosts, eq(storyPosts.processedPostId, processedPosts.id))
    .where(
      and(
        eq(processedPosts.workspaceId, input.workspaceId),
        eq(radarCandidateEmbeddings.model, input.model),
        sql`${storyPosts.processedPostId} is null`,
      ),
    )
    .orderBy(asc(processedPosts.createdAt), asc(processedPosts.id));
  return rows.map((row) => row.id);
}

/** Forget a workspace's stories, to cluster its posts again from the start. */
export async function deleteStories(db: Db, workspaceId: number): Promise<void> {
  await db.delete(stories).where(eq(stories.workspaceId, workspaceId));
}
