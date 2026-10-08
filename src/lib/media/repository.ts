import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import { mediaUnderstandings, type MediaUnderstandingRow } from '@/db/schema';
import type { ImageUnderstanding, MediaUnderstandingConfig } from '@/lib/media/understanding';

/** Database access for image understandings, by fingerprint and the config that makes one current. */

/** The stored understanding of this image under this config, failed ones included, or null. */
export async function findUnderstanding(
  db: Database,
  input: { fingerprint: string; config: MediaUnderstandingConfig },
): Promise<MediaUnderstandingRow | null> {
  const [row] = await db.select().from(mediaUnderstandings).where(current(input.config, [input.fingerprint]));
  return row ?? null;
}

/** The current, successful understandings of these images, by fingerprint. */
export async function loadUnderstandings(
  db: Database,
  input: { fingerprints: string[]; config: MediaUnderstandingConfig },
): Promise<Map<string, MediaUnderstandingRow>> {
  const fingerprints = [...new Set(input.fingerprints)];
  if (fingerprints.length === 0) return new Map();
  const rows = await db
    .select()
    .from(mediaUnderstandings)
    .where(and(current(input.config, fingerprints), eq(mediaUnderstandings.status, 'ok')));
  return new Map(rows.map((row) => [row.fingerprint, row]));
}

/** Record a fresh understanding, replacing a failed attempt at the same one. */
export async function saveUnderstanding(
  db: Database,
  row: {
    fingerprint: string;
    config: MediaUnderstandingConfig;
    understanding: ImageUnderstanding | null;
    error?: string;
    mediaType: string | null;
    byteLength: number;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    latencyMs: number;
  },
): Promise<MediaUnderstandingRow> {
  const fields = {
    status: row.understanding ? ('ok' as const) : ('failed' as const),
    summary: row.understanding?.summary ?? null,
    contentType: row.understanding?.contentType ?? null,
    topics: row.understanding?.topics ?? [],
    entities: row.understanding?.entities ?? [],
    visibleText: row.understanding?.visibleText ?? null,
    informationValue: row.understanding?.informationValue ?? null,
    mediaType: row.mediaType,
    byteLength: row.byteLength,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costUsd: row.costUsd,
    latencyMs: row.latencyMs,
    error: row.error ?? null,
  };

  const [saved] = await db
    .insert(mediaUnderstandings)
    .values({
      fingerprint: row.fingerprint,
      model: row.config.model,
      promptVersion: row.config.promptVersion,
      detail: row.config.detail,
      ...fields,
    })
    .onConflictDoUpdate({
      target: [
        mediaUnderstandings.fingerprint,
        mediaUnderstandings.model,
        mediaUnderstandings.promptVersion,
        mediaUnderstandings.detail,
      ],
      set: { ...fields, updatedAt: new Date() },
      // A success is never overwritten — by a failure, or by a rival success.
      setWhere: sql`${mediaUnderstandings.status} <> 'ok'`,
    })
    .returning();

  return saved ?? (await findUnderstanding(db, row))!;
}

/** A stored row as the domain type, or null for a failed one. */
export function understandingOf(row: MediaUnderstandingRow | null | undefined): ImageUnderstanding | null {
  if (!row || row.status !== 'ok' || !row.summary) return null;
  return {
    summary: row.summary,
    contentType: (row.contentType ?? 'other') as ImageUnderstanding['contentType'],
    topics: row.topics,
    entities: row.entities,
    visibleText: row.visibleText,
    informationValue: (row.informationValue ?? 'supporting') as ImageUnderstanding['informationValue'],
  };
}

function current(config: MediaUnderstandingConfig, fingerprints: string[]) {
  return and(
    inArray(mediaUnderstandings.fingerprint, fingerprints),
    eq(mediaUnderstandings.model, config.model),
    eq(mediaUnderstandings.promptVersion, config.promptVersion),
    eq(mediaUnderstandings.detail, config.detail),
  );
}
