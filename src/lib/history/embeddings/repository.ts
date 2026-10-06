import { and, asc, count, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import {
  publicationHistoryEmbeddings,
  publicationHistoryItems,
  radarCandidateEmbeddings,
  type HistoryContentType,
} from '@/db/schema';

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

export async function upsertCandidateEmbedding(
  db: Database,
  row: { processedPostId: number; model: string; contentFingerprint: string; embedding: number[]; inputTokens: number },
): Promise<void> {
  await db
    .insert(radarCandidateEmbeddings)
    .values({ ...row, dimensions: row.embedding.length })
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
