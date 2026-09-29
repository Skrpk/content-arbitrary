import { and, asc, eq, sql as rawSql } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import {
  DEFAULT_WORKSPACE_ID,
  sources,
  type Source,
  type SourcePlatform,
} from '@/db/schema';

/**
 * All database access for the source list.
 *
 * The sync layer and the Telegram command handlers both go through here, so
 * neither needs to know how sources are stored — which is what will let a
 * future ownership column land without touching either of them.
 */

export async function listSources(
  db: Database,
  workspaceId: number = DEFAULT_WORKSPACE_ID,
): Promise<Source[]> {
  return db
    .select()
    .from(sources)
    .where(eq(sources.workspaceId, workspaceId))
    .orderBy(asc(sources.createdAt), asc(sources.id));
}

export async function listEnabledSources(
  db: Database,
  platform: SourcePlatform = 'x',
  workspaceId: number = DEFAULT_WORKSPACE_ID,
): Promise<Source[]> {
  return db
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.workspaceId, workspaceId),
        eq(sources.platform, platform),
        eq(sources.enabled, true),
      ),
    )
    .orderBy(asc(sources.createdAt), asc(sources.id));
}

export async function countSources(
  db: Database,
  workspaceId: number = DEFAULT_WORKSPACE_ID,
): Promise<number> {
  const rows = await db
    .select({ count: rawSql<number>`count(*)::int` })
    .from(sources)
    .where(eq(sources.workspaceId, workspaceId));
  return rows[0]?.count ?? 0;
}

export async function findSourceByExternalId(
  db: Database,
  input: { platform: SourcePlatform; externalId: string; workspaceId?: number },
): Promise<Source | null> {
  const rows = await db
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.workspaceId, input.workspaceId ?? DEFAULT_WORKSPACE_ID),
        eq(sources.platform, input.platform),
        eq(sources.externalId, input.externalId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Look up by handle. Only for resolving what the admin typed in a command —
 * never for deciding identity, because handles can be renamed and reused.
 */
export async function findSourceByUsername(
  db: Database,
  input: { platform: SourcePlatform; username: string; workspaceId?: number },
): Promise<Source | null> {
  const rows = await db
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.workspaceId, input.workspaceId ?? DEFAULT_WORKSPACE_ID),
        eq(sources.platform, input.platform),
        rawSql`lower(${sources.username}) = lower(${input.username})`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface AddSourceResult {
  source: Source;
  /** False when the account was already on the list. */
  created: boolean;
}

/**
 * Add a source, or return the existing row for the same account.
 *
 * The UNIQUE index on (platform, external_id) does the deciding, so two admins
 * adding the same account at once produce one row rather than an error. A
 * renamed handle updates the cached username in passing.
 */
export async function addSource(
  db: Database,
  input: { platform: SourcePlatform; externalId: string; username: string; workspaceId?: number },
): Promise<AddSourceResult> {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const existing = await findSourceByExternalId(db, { ...input, workspaceId });

  const rows = await db
    .insert(sources)
    .values({
      workspaceId,
      platform: input.platform,
      externalId: input.externalId,
      username: input.username,
    })
    .onConflictDoUpdate({
      target: [sources.workspaceId, sources.platform, sources.externalId],
      set: { username: input.username, updatedAt: new Date() },
    })
    .returning();

  return { source: rows[0]!, created: existing === null };
}

export async function setSourceEnabled(
  db: Database,
  input: { id: number; enabled: boolean },
): Promise<Source | null> {
  const rows = await db
    .update(sources)
    .set({ enabled: input.enabled, updatedAt: new Date() })
    .where(eq(sources.id, input.id))
    .returning();
  return rows[0] ?? null;
}

/** Refresh the cached handle after X reports a rename. */
export async function updateSourceUsername(
  db: Database,
  input: { id: number; username: string },
): Promise<void> {
  await db
    .update(sources)
    .set({ username: input.username, updatedAt: new Date() })
    .where(eq(sources.id, input.id));
}

/**
 * Remove a source permanently.
 *
 * Its `sync_state` cursor is deliberately left behind: it is keyed by the
 * platform id, so re-adding the same account later resumes where it stopped
 * instead of re-reading (and re-paying for) the whole window.
 */
export async function deleteSource(db: Database, id: number): Promise<boolean> {
  const rows = await db.delete(sources).where(eq(sources.id, id)).returning({ id: sources.id });
  return rows.length > 0;
}

/** Stable `sync_state` key for a source. Unchanged from the single-source era. */
export function syncStateKey(source: Pick<Source, 'platform' | 'externalId'>): string {
  return `${source.platform}:${source.externalId}`;
}
