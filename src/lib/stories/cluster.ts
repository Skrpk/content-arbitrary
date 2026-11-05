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
 *
 * The same event told in two languages sits lower: on VECTOR, of the 27
 * nearest posts at 0.60 or above from another source and another alphabet,
 * only one reached 0.75, and all but about two of the rest were the same
 * article. So two posts in different alphabets need less.
 */
export const STORY_SIMILARITY_THRESHOLD = 0.75;
export const STORY_CROSS_LANGUAGE_THRESHOLD = 0.6;
/** How far back a post looks for its story. */
export const STORY_WINDOW_HOURS = 48;
/**
 * How many of the nearest posts are looked at: the very nearest may be in the
 * post's own language and too far, with the same event in another just behind it.
 */
const NEIGHBOURS = 10;

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

/** Which alphabet most of a text's letters are in; null for a text with no letters. */
export function alphabetOf(text: string | null): 'cyrillic' | 'latin' | null {
  const cyrillic = text?.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
  const latin = text?.match(/\p{Script=Latin}/gu)?.length ?? 0;
  if (cyrillic === 0 && latin === 0) return null;
  return cyrillic > latin ? 'cyrillic' : 'latin';
}

/**
 * Put a post in its story, once. Null when the post has no vector for
 * `model` — no text and no understood image, or never searched with — and so
 * nothing to compare.
 */
export async function placeInStory(
  db: Db,
  input: {
    workspaceId: number;
    processedPostId: number;
    model: string;
    threshold?: number;
    crossLanguageThreshold?: number;
    windowHours?: number;
  },
): Promise<StoryPlacement | null> {
  const sameLanguage = input.threshold ?? STORY_SIMILARITY_THRESHOLD;
  const crossLanguage = input.crossLanguageThreshold ?? STORY_CROSS_LANGUAGE_THRESHOLD;
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
      .select({
        embedding: radarCandidateEmbeddings.embedding,
        arrivedAt: processedPosts.createdAt,
        text: processedPosts.sourceText,
      })
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
    const neighbours = await tx
      .select({
        processedPostId: processedPosts.id,
        storyId: storyPosts.storyId,
        text: processedPosts.sourceText,
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
      .limit(NEIGHBOURS);

    const alphabet = alphabetOf(post.text);
    const thresholdFor = (other: { text: string | null }) => {
      const otherAlphabet = alphabetOf(other.text);
      return alphabet && otherAlphabet && alphabet !== otherAlphabet ? crossLanguage : sameLanguage;
    };
    const match = neighbours.find((neighbour) => neighbour.similarity >= thresholdFor(neighbour));
    const nearest = match ?? neighbours[0];
    const storyId = match
      ? match.storyId
      : (await tx.insert(stories).values({ workspaceId: input.workspaceId }).returning({ id: stories.id }))[0]!.id;

    await tx.insert(storyPosts).values({
      processedPostId: input.processedPostId,
      storyId,
      nearestPostId: nearest?.processedPostId ?? null,
      similarity: nearest?.similarity ?? null,
      threshold: nearest ? thresholdFor(nearest) : sameLanguage,
      embeddingModel: input.model,
    });

    return {
      storyId,
      outcome: match ? ('joined' as const) : ('started' as const),
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
