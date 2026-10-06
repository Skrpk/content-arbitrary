import { and, count, eq, inArray, max, min, sql } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import { publicationHistoryImports, publicationHistoryItems } from '@/db/schema';
import type { HistoricalPublicationItem } from '@/lib/history/types';

/**
 * Rows per upsert statement: big enough that a long history takes few round
 * trips, small enough to stay far below Postgres's 65,535 bind parameters
 * (~14 per row).
 */
export const HISTORY_UPSERT_BATCH = 500;

/** Open the audit record for an import, before anything is parsed. */
export async function createHistoryImport(
  db: Database,
  input: { workspaceId: number; adapter: string; originalFilename: string; fileSha256: string },
): Promise<number> {
  const [row] = await db
    .insert(publicationHistoryImports)
    .values({ ...input, status: 'processing' })
    .returning({ id: publicationHistoryImports.id });
  return row!.id;
}

export interface HistoryImportCounts {
  seen: number;
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
}

export async function completeHistoryImport(
  db: Database,
  importId: number,
  input: {
    platform: string;
    publicationKey: string;
    counts: HistoryImportCounts;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .update(publicationHistoryImports)
    .set({
      status: 'completed',
      platform: input.platform,
      publicationKey: input.publicationKey,
      itemsSeen: input.counts.seen,
      itemsImported: input.counts.imported,
      itemsUpdated: input.counts.updated,
      itemsUnchanged: input.counts.unchanged,
      itemsSkipped: input.counts.skipped,
      itemsFailed: input.counts.failed,
      metadata: input.metadata,
      completedAt: new Date(),
    })
    .where(eq(publicationHistoryImports.id, importId));
}

export async function failHistoryImport(
  db: Database,
  importId: number,
  input: { errorMessage: string; platform?: string; publicationKey?: string },
): Promise<void> {
  await db
    .update(publicationHistoryImports)
    .set({
      status: 'failed',
      errorMessage: input.errorMessage.slice(0, 2000),
      platform: input.platform ?? null,
      publicationKey: input.publicationKey ?? null,
      completedAt: new Date(),
    })
    .where(eq(publicationHistoryImports.id, importId));
}

/**
 * Store one publication's items, inserting the new ones and updating the ones
 * already there.
 *
 * Identity — workspace, platform, publication, external id — is never changed.
 * Everything else is what the export says, so the latest import wins: a later
 * export that includes media files the first one left out fills them in. A row
 * the export holds exactly as stored is not touched at all, so re-running the
 * same import changes nothing, not even `updated_at`.
 *
 * All or nothing: the batches share one transaction, so a failure or an
 * interruption part-way leaves the table as it was. Item ids must be unique
 * within the call.
 */
export async function upsertPublicationHistoryItems(
  db: Database,
  input: {
    workspaceId: number;
    platform: string;
    publicationKey: string;
    importId: number | null;
    items: HistoricalPublicationItem[];
    /** Checked between batches, so an interrupted import stops cleanly. */
    signal?: AbortSignal;
  },
): Promise<{ imported: number; updated: number; unchanged: number }> {
  const table = publicationHistoryItems;
  let imported = 0;
  let updated = 0;

  await db.transaction(async (tx) => {
    for (let start = 0; start < input.items.length; start += HISTORY_UPSERT_BATCH) {
      input.signal?.throwIfAborted();
      const batch = input.items.slice(start, start + HISTORY_UPSERT_BATCH);

      const written = await tx
        .insert(table)
        .values(
          batch.map((item) => ({
            workspaceId: input.workspaceId,
            platform: input.platform,
            publicationKey: input.publicationKey,
            externalId: item.externalId,
            contentType: item.contentType,
            title: item.title,
            text: item.text,
            publishedAt: item.publishedAt,
            editedAt: item.editedAt,
            canonicalUrl: item.canonicalUrl,
            media: item.media,
            metrics: item.metrics,
            metadata: item.metadata,
            importId: input.importId,
          })),
        )
        .onConflictDoUpdate({
          target: [table.workspaceId, table.platform, table.publicationKey, table.externalId],
          set: {
            contentType: sql`excluded.content_type`,
            title: sql`excluded.title`,
            text: sql`excluded.text`,
            publishedAt: sql`excluded.published_at`,
            editedAt: sql`excluded.edited_at`,
            canonicalUrl: sql`excluded.canonical_url`,
            media: sql`excluded.media`,
            metrics: sql`excluded.metrics`,
            metadata: sql`excluded.metadata`,
            importId: sql`excluded.import_id`,
            updatedAt: sql`now()`,
          },
          // Only rows that differ; the others are left alone and not returned.
          setWhere: sql`(${table.contentType}, ${table.title}, ${table.text}, ${table.publishedAt},
            ${table.editedAt}, ${table.canonicalUrl}, ${table.media}, ${table.metrics}, ${table.metadata})
            IS DISTINCT FROM (excluded.content_type, excluded.title, excluded.text, excluded.published_at,
            excluded.edited_at, excluded.canonical_url, excluded.media, excluded.metrics, excluded.metadata)`,
        })
        // xmax is 0 on a freshly inserted row and set on an updated one.
        .returning({ inserted: sql<boolean>`(xmax = 0)` });

      for (const row of written) {
        if (row.inserted) imported += 1;
        else updated += 1;
      }
    }
  });

  return { imported, updated, unchanged: input.items.length - imported - updated };
}

/** How many of these ids one publication already has stored — for a dry run. */
export async function countStoredHistoryItems(
  db: Database,
  input: { workspaceId: number; platform: string; publicationKey: string; externalIds: string[] },
): Promise<number> {
  const table = publicationHistoryItems;
  let stored = 0;
  // One bind parameter per id: chunked to stay under Postgres's limit.
  for (let start = 0; start < input.externalIds.length; start += 10_000) {
    const [row] = await db
      .select({ stored: count() })
      .from(table)
      .where(
        and(
          eq(table.workspaceId, input.workspaceId),
          eq(table.platform, input.platform),
          eq(table.publicationKey, input.publicationKey),
          inArray(table.externalId, input.externalIds.slice(start, start + 10_000)),
        ),
      );
    stored += row?.stored ?? 0;
  }
  return stored;
}

export interface PublicationHistoryStats {
  platform: string;
  publicationKey: string;
  items: number;
  firstPublishedAt: Date | null;
  lastPublishedAt: Date | null;
}

/** What history a workspace holds, per publication. */
export async function getPublicationHistoryStats(
  db: Database,
  workspaceId: number,
): Promise<PublicationHistoryStats[]> {
  const table = publicationHistoryItems;
  return db
    .select({
      platform: table.platform,
      publicationKey: table.publicationKey,
      items: count(),
      firstPublishedAt: min(table.publishedAt),
      lastPublishedAt: max(table.publishedAt),
    })
    .from(table)
    .where(eq(table.workspaceId, workspaceId))
    .groupBy(table.platform, table.publicationKey)
    .orderBy(table.platform, table.publicationKey);
}
