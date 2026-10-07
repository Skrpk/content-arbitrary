import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import { processedPosts, sources, type RejectionReason } from '@/db/schema';

/**
 * How each source has served its channel: what it brought in, and what the
 * reviewer made of it. Behind /sourcestats — the numbers to decide which
 * accounts earn what they cost to read.
 *
 * Counted from `processed_posts`, so only posts the bot kept a row for. Posts
 * X returned that the bot passed over (a quote, a post with no usable media)
 * leave no row but were still read, which makes the read cost a floor.
 */

/** X's price per post read, pay-per-use. See README → "The X API is paid, per post read". */
export const X_POST_READ_USD = 0.005;

export const STATS_PERIODS = ['7d', '30d', 'all'] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];

/** Where a period starts, or null for all time. */
export function periodStart(period: StatsPeriod, now = new Date()): Date | null {
  if (period === 'all') return null;
  const days = period === '7d' ? 7 : 30;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export interface SourceStats {
  sourceId: number;
  workspaceId: number;
  username: string;
  enabled: boolean;
  /** Every post the source brought in this period. */
  posts: number;
  /** Published, or scheduled to be. */
  approved: number;
  rejected: number;
  /** Still in review. */
  waiting: number;
  /** Never reached review: skipped (no sendable media), failed, or not yet sent. */
  notSent: number;
  /** approved / (approved + rejected); null before anything was decided. */
  approvalRate: number | null;
  rejectionReasons: { reason: RejectionReason | null; count: number }[];
  /** At least this much spent reading its posts from X. */
  readCostUsd: number;
  /** readCostUsd per approved post; null with none approved. */
  costPerApprovedUsd: number | null;
  lastPostAt: Date | null;
}

/**
 * Stats for every source of the given workspaces, idle ones included, over
 * posts that arrived since `since` (all time when null).
 */
export async function loadSourceStats(
  db: Database,
  input: { workspaceIds: number[]; since: Date | null },
): Promise<SourceStats[]> {
  if (input.workspaceIds.length === 0) return [];

  const inPeriod = and(
    eq(processedPosts.sourceId, sources.id),
    input.since ? gte(processedPosts.createdAt, input.since) : undefined,
  );
  const withStatus = (statuses: string[]) =>
    sql<number>`(count(*) filter (where ${processedPosts.status} in (${sql.join(
      statuses.map((status) => sql`${status}`),
      sql`, `,
    )})))::int`;

  const rows = await db
    .select({
      sourceId: sources.id,
      workspaceId: sources.workspaceId,
      username: sources.username,
      enabled: sources.enabled,
      posts: sql<number>`count(${processedPosts.id})::int`,
      approved: withStatus(['published', 'scheduled']),
      rejected: withStatus(['rejected']),
      waiting: withStatus(['awaiting_approval']),
      lastPostAt: sql<Date | null>`max(${processedPosts.createdAt})`.mapWith(processedPosts.createdAt),
    })
    .from(sources)
    .leftJoin(processedPosts, inPeriod)
    .where(inArray(sources.workspaceId, input.workspaceIds))
    .groupBy(sources.id)
    .orderBy(sources.workspaceId, desc(sql`count(${processedPosts.id})`), sources.username);

  const reasons = await db
    .select({
      sourceId: processedPosts.sourceId,
      reason: processedPosts.rejectionReason,
      count: sql<number>`count(*)::int`,
    })
    .from(processedPosts)
    .where(
      and(
        inArray(processedPosts.workspaceId, input.workspaceIds),
        isNotNull(processedPosts.sourceId),
        eq(processedPosts.status, 'rejected'),
        input.since ? gte(processedPosts.createdAt, input.since) : undefined,
      ),
    )
    .groupBy(processedPosts.sourceId, processedPosts.rejectionReason)
    .orderBy(desc(sql`count(*)`));

  return rows.map((row) => {
    const decided = row.approved + row.rejected;
    const readCostUsd = row.posts * X_POST_READ_USD;
    return {
      ...row,
      notSent: row.posts - row.approved - row.rejected - row.waiting,
      approvalRate: decided > 0 ? row.approved / decided : null,
      rejectionReasons: reasons
        .filter((entry) => entry.sourceId === row.sourceId)
        .map(({ reason, count }) => ({ reason, count })),
      readCostUsd,
      costPerApprovedUsd: row.approved > 0 ? readCostUsd / row.approved : null,
    };
  });
}
