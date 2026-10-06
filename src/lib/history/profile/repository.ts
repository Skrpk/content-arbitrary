import { and, asc, desc, eq, lte } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import { publicationHistoryItems, publicationHistoryProfiles, type PublicationHistoryProfileRow } from '@/db/schema';
import type { Logger } from '@/lib/logger';
import { publicationProfileSchema, type PublicationProfile } from '@/lib/history/profile/schema';
import { usableForProfile, type ProfileSourceItem } from '@/lib/history/profile/source';

/** The workspace's publication history, oldest first, as the profiler reads it. */
export async function loadProfileSource(db: Database, workspaceId: number): Promise<ProfileSourceItem[]> {
  const rows = await db
    .select({
      id: publicationHistoryItems.id,
      platform: publicationHistoryItems.platform,
      publicationKey: publicationHistoryItems.publicationKey,
      externalId: publicationHistoryItems.externalId,
      text: publicationHistoryItems.text,
      publishedAt: publicationHistoryItems.publishedAt,
      media: publicationHistoryItems.media,
    })
    .from(publicationHistoryItems)
    .where(eq(publicationHistoryItems.workspaceId, workspaceId))
    .orderBy(asc(publicationHistoryItems.publishedAt), asc(publicationHistoryItems.id));

  return rows
    .map(({ media, ...row }) => ({ ...row, mediaTypes: (media ?? []).map((item) => item.type) }))
    .filter(usableForProfile);
}

/** A profile already made from exactly this history, prompt and model. */
export async function findProfile(
  db: Database,
  input: { workspaceId: number; sourceFingerprint: string; promptVersion: string; model: string },
): Promise<PublicationHistoryProfileRow | undefined> {
  const [row] = await db
    .select()
    .from(publicationHistoryProfiles)
    .where(
      and(
        eq(publicationHistoryProfiles.workspaceId, input.workspaceId),
        eq(publicationHistoryProfiles.sourceFingerprint, input.sourceFingerprint),
        eq(publicationHistoryProfiles.promptVersion, input.promptVersion),
        eq(publicationHistoryProfiles.model, input.model),
      ),
    )
    .orderBy(desc(publicationHistoryProfiles.id))
    .limit(1);
  return row;
}

export async function insertPublicationProfile(
  db: Database,
  values: typeof publicationHistoryProfiles.$inferInsert,
): Promise<PublicationHistoryProfileRow> {
  const [row] = await db.insert(publicationHistoryProfiles).values(values).returning();
  return row!;
}

export async function latestPublicationProfile(
  db: Database,
  workspaceId: number,
): Promise<PublicationHistoryProfileRow | undefined> {
  const [row] = await db
    .select()
    .from(publicationHistoryProfiles)
    .where(eq(publicationHistoryProfiles.workspaceId, workspaceId))
    .orderBy(desc(publicationHistoryProfiles.id))
    .limit(1);
  return row;
}

/**
 * The profile Radar may show when predicting a post that arrived at
 * `arrivedAt`: the newest one made only from publications before then.
 *
 * Live, that is simply the newest profile. In a backfill it keeps the score
 * honest: a profile that saw posts published after the candidate arrived
 * would be hindsight, so it is not used, and the candidate is scored without
 * one. A stored profile that no longer matches the schema is treated as
 * absent.
 */
export async function loadRadarPublicationProfile(
  db: Database,
  input: { workspaceId: number; arrivedAt: Date; logger?: Logger },
): Promise<{ id: number; profile: PublicationProfile } | null> {
  const [row] = await db
    .select({ id: publicationHistoryProfiles.id, profile: publicationHistoryProfiles.profile })
    .from(publicationHistoryProfiles)
    .where(
      and(
        eq(publicationHistoryProfiles.workspaceId, input.workspaceId),
        lte(publicationHistoryProfiles.historyCutoffAt, input.arrivedAt),
      ),
    )
    .orderBy(desc(publicationHistoryProfiles.id))
    .limit(1);
  if (!row) return null;

  const parsed = publicationProfileSchema.safeParse(row.profile);
  if (!parsed.success) {
    input.logger?.warn('radar.history_profile_invalid', { profileId: row.id });
    return null;
  }
  return { id: row.id, profile: parsed.data };
}
