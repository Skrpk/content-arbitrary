import { and, asc, count, eq, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import {
  processedPosts,
  publicationHistoryEmbeddings,
  publicationHistoryItems,
  radarCandidateEmbeddings,
  type HistoryContentType,
} from '@/db/schema';
import { APPROVED_STATUSES } from '@/lib/radar/repository';

/** A workspace's history items with the fingerprint of their stored vector for `model`, if any. */
export async function loadHistoryForEmbedding(db: Database, input: { workspaceId: number; model: string }) {
  return db
    .select({
      id: publicationHistoryItems.id,
      title: publicationHistoryItems.title,
      text: publicationHistoryItems.text,
      storedFingerprint: publicationHistoryEmbeddings.contentFingerprint,
    })
    .from(publicationHistoryItems)
    .leftJoin(
      publicationHistoryEmbeddings,
      and(
        eq(publicationHistoryEmbeddings.publicationHistoryItemId, publicationHistoryItems.id),
        eq(publicationHistoryEmbeddings.model, input.model),
      ),
    )
    .where(eq(publicationHistoryItems.workspaceId, input.workspaceId))
    .orderBy(asc(publicationHistoryItems.publishedAt), asc(publicationHistoryItems.id));
}

/** Store vectors, replacing an item's earlier vector for the same model. */
export async function upsertHistoryEmbeddings(
  db: Database,
  rows: { itemId: number; model: string; contentFingerprint: string; embedding: number[] }[],
): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(publicationHistoryEmbeddings)
    .values(
      rows.map((row) => ({
        publicationHistoryItemId: row.itemId,
        model: row.model,
        dimensions: row.embedding.length,
        contentFingerprint: row.contentFingerprint,
        embedding: row.embedding,
      })),
    )
    .onConflictDoUpdate({
      target: [publicationHistoryEmbeddings.publicationHistoryItemId, publicationHistoryEmbeddings.model],
      set: {
        dimensions: sql`excluded.dimensions`,
        contentFingerprint: sql`excluded.content_fingerprint`,
        embedding: sql`excluded.embedding`,
        updatedAt: new Date(),
      },
    });
}

/** Drop vectors of items that no longer have text to match them. */
export async function deleteHistoryEmbeddings(
  db: Database,
  input: { itemIds: number[]; model: string },
): Promise<void> {
  if (input.itemIds.length === 0) return;
  await db
    .delete(publicationHistoryEmbeddings)
    .where(
      and(
        inArray(publicationHistoryEmbeddings.publicationHistoryItemId, input.itemIds),
        eq(publicationHistoryEmbeddings.model, input.model),
      ),
    );
}

/** One past publication found similar to a new post. */
export interface HistoricalMatch {
  itemId: number;
  /** Cosine similarity of the two embeddings, -1..1. */
  similarity: number;
  title: string | null;
  text: string | null;
  platform: string;
  contentType: HistoryContentType;
  publishedAt: Date;
  canonicalUrl: string | null;
}

/**
 * The workspace's embedded publications from before `before`, how many there
 * are for this model — zero means there is nothing to search.
 */
export async function countSearchableHistory(
  db: Database,
  input: { workspaceId: number; model: string; before: Date },
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(publicationHistoryEmbeddings)
    .innerJoin(
      publicationHistoryItems,
      eq(publicationHistoryItems.id, publicationHistoryEmbeddings.publicationHistoryItemId),
    )
    .where(searchable(input));
  return row?.total ?? 0;
}

/**
 * The `limit` past publications nearest to `embedding`, most similar first.
 *
 * Every boundary is part of the query, not left to the caller or the prompt:
 * only this workspace's history, only vectors of this model and length, and
 * only what was published strictly before `before` — the moment the post
 * arrived — so a backfill never shows the model what the channel published
 * later. An exact scan: a workspace's history is small enough not to need an
 * approximate index, and an exact one returns the true nearest items.
 */
export async function findSimilarHistoricalItems(
  db: Database,
  input: { workspaceId: number; model: string; embedding: number[]; before: Date; limit: number },
): Promise<HistoricalMatch[]> {
  const query = sql`${`[${input.embedding.join(',')}]`}::vector`;
  const distance = sql`${publicationHistoryEmbeddings.embedding} <=> ${query}`;

  const rows = await db
    .select({
      itemId: publicationHistoryItems.id,
      similarity: sql<number>`1 - (${distance})`.mapWith(Number),
      title: publicationHistoryItems.title,
      text: publicationHistoryItems.text,
      platform: publicationHistoryItems.platform,
      contentType: publicationHistoryItems.contentType,
      publishedAt: publicationHistoryItems.publishedAt,
      canonicalUrl: publicationHistoryItems.canonicalUrl,
    })
    .from(publicationHistoryEmbeddings)
    .innerJoin(
      publicationHistoryItems,
      eq(publicationHistoryItems.id, publicationHistoryEmbeddings.publicationHistoryItemId),
    )
    .where(and(searchable(input), eq(publicationHistoryEmbeddings.dimensions, input.embedding.length)))
    .orderBy(distance, asc(publicationHistoryItems.id))
    .limit(input.limit);

  return rows;
}

function searchable(input: { workspaceId: number; model: string; before: Date }) {
  return and(
    eq(publicationHistoryItems.workspaceId, input.workspaceId),
    eq(publicationHistoryEmbeddings.model, input.model),
    lt(publicationHistoryItems.publishedAt, input.before),
  );
}

/** A post's stored vector for `model`, if it was made from exactly this text. */
export async function findCandidateEmbedding(
  db: Database,
  input: { processedPostId: number; model: string; contentFingerprint: string },
): Promise<number[] | null> {
  const [row] = await db
    .select({ embedding: radarCandidateEmbeddings.embedding })
    .from(radarCandidateEmbeddings)
    .where(
      and(
        eq(radarCandidateEmbeddings.processedPostId, input.processedPostId),
        eq(radarCandidateEmbeddings.model, input.model),
        eq(radarCandidateEmbeddings.contentFingerprint, input.contentFingerprint),
      ),
    );
  return row?.embedding ?? null;
}

export interface CandidateEmbeddingRow {
  processedPostId: number;
  model: string;
  contentFingerprint: string;
  embedding: number[];
  /** Tokens of the request that made it, or null when it was one of several. */
  inputTokens: number | null;
}

export async function upsertCandidateEmbedding(db: Database, row: CandidateEmbeddingRow): Promise<void> {
  await upsertCandidateEmbeddings(db, [row]);
}

export async function upsertCandidateEmbeddings(db: Database, rows: CandidateEmbeddingRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(radarCandidateEmbeddings)
    .values(rows.map((row) => ({ ...row, dimensions: row.embedding.length })))
    .onConflictDoUpdate({
      target: [radarCandidateEmbeddings.processedPostId, radarCandidateEmbeddings.model],
      set: {
        dimensions: sql`excluded.dimensions`,
        contentFingerprint: sql`excluded.content_fingerprint`,
        embedding: sql`excluded.embedding`,
        inputTokens: sql`excluded.input_tokens`,
        createdAt: new Date(),
      },
    });
}

/** A workspace's processed posts with text, and the fingerprint of their stored vector for `model`, if any. */
export async function loadProcessedPostsForEmbedding(db: Database, input: { workspaceId: number; model: string }) {
  return db
    .select({
      id: processedPosts.id,
      text: processedPosts.sourceText,
      storedFingerprint: radarCandidateEmbeddings.contentFingerprint,
    })
    .from(processedPosts)
    .leftJoin(
      radarCandidateEmbeddings,
      and(eq(radarCandidateEmbeddings.processedPostId, processedPosts.id), eq(radarCandidateEmbeddings.model, input.model)),
    )
    .where(and(eq(processedPosts.workspaceId, input.workspaceId), isNotNull(processedPosts.sourceText)))
    .orderBy(asc(processedPosts.id));
}

/** One post the editor already approved, found similar to a new one. */
export interface ApprovedMatch {
  processedPostId: number;
  /** Cosine similarity of the two embeddings, -1..1. */
  similarity: number;
  text: string | null;
  sourceUsername: string | null;
  /** When the editor approved it. */
  approvedAt: Date;
}

interface ApprovedScope {
  workspaceId: number;
  model: string;
  before: Date;
  /** The candidate itself, never its own match. */
  excludePostId: number;
}

/** How many embedded posts the editor had approved before `before` — zero means nothing to search. */
export async function countSearchableApproved(db: Database, input: ApprovedScope): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(radarCandidateEmbeddings)
    .innerJoin(processedPosts, eq(processedPosts.id, radarCandidateEmbeddings.processedPostId))
    .where(approvedBefore(input));
  return row?.total ?? 0;
}

/**
 * The `limit` posts the editor had approved before `before` nearest to
 * `embedding`, most similar first. Like the history search, every boundary is
 * in the query: this workspace, this model and length, approved — published
 * or scheduled — and decided strictly before the candidate arrived, so a
 * backfill never sees an approval the editor had not yet made.
 */
export async function findSimilarApprovedPosts(
  db: Database,
  input: ApprovedScope & { embedding: number[]; limit: number },
): Promise<ApprovedMatch[]> {
  const query = sql`${`[${input.embedding.join(',')}]`}::vector`;
  const distance = sql`${radarCandidateEmbeddings.embedding} <=> ${query}`;

  const rows = await db
    .select({
      processedPostId: processedPosts.id,
      similarity: sql<number>`1 - (${distance})`.mapWith(Number),
      text: processedPosts.sourceText,
      sourceUsername: processedPosts.xAuthorUsername,
      approvedAt: processedPosts.reviewedAt,
    })
    .from(radarCandidateEmbeddings)
    .innerJoin(processedPosts, eq(processedPosts.id, radarCandidateEmbeddings.processedPostId))
    .where(and(approvedBefore(input), eq(radarCandidateEmbeddings.dimensions, input.embedding.length)))
    .orderBy(distance, asc(processedPosts.id))
    .limit(input.limit);

  // reviewed_at is non-null by the filter.
  return rows.map((row) => ({ ...row, approvedAt: row.approvedAt! }));
}

function approvedBefore(input: ApprovedScope) {
  return and(
    eq(processedPosts.workspaceId, input.workspaceId),
    eq(radarCandidateEmbeddings.model, input.model),
    inArray(processedPosts.status, [...APPROVED_STATUSES]),
    lt(processedPosts.reviewedAt, input.before),
    ne(processedPosts.id, input.excludePostId),
  );
}
