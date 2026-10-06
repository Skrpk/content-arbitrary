import { and, count, desc, eq, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import {
  processedPosts,
  radarEvaluations,
  type RadarMode,
  type RadarVariant,
} from '@/db/schema';
import { describeStoredMedia, type RadarExample } from '@/lib/radar/prompt';

/** Statuses that mean the editor said yes: published, or scheduled to be. */
const APPROVED_STATUSES = ['published', 'scheduled'] as const;

/**
 * The editor's decisions made before `before`, as Radar's examples, and the
 * share of all those decisions that were approvals.
 *
 * "Before" is what keeps a prediction honest: a live score sees only what was
 * decided before the post arrived, and a backfill must see exactly that and no
 * more, or it is scoring with hindsight. Only reviewed posts count — one
 * published without review says nothing about the editor's taste.
 */
export async function loadRadarHistory(
  db: Database,
  input: { workspaceId: number; before: Date; excludePostId?: number; perClass: number },
): Promise<{ examples: RadarExample[]; approvalRate: number | null; decisions: number }> {
  const decidedBefore = and(
    eq(processedPosts.workspaceId, input.workspaceId),
    isNotNull(processedPosts.reviewedAt),
    lt(processedPosts.reviewedAt, input.before),
    input.excludePostId === undefined ? undefined : ne(processedPosts.id, input.excludePostId),
  );

  const columns = {
    id: processedPosts.id,
    sourceUsername: processedPosts.xAuthorUsername,
    sourceText: processedPosts.sourceText,
    method: processedPosts.telegramMethod,
    mediaCount: processedPosts.mediaCount,
    status: processedPosts.status,
    rejectionReason: processedPosts.rejectionReason,
    rejectionNote: processedPosts.rejectionNote,
  };

  const [approved, rejected, [totals]] = await Promise.all([
    db
      .select(columns)
      .from(processedPosts)
      .where(
        and(
          decidedBefore,
          inArray(processedPosts.status, [...APPROVED_STATUSES]),
          isNotNull(processedPosts.sourceText),
        ),
      )
      .orderBy(desc(processedPosts.reviewedAt))
      .limit(input.perClass),
    db
      .select(columns)
      .from(processedPosts)
      .where(
        and(
          decidedBefore,
          eq(processedPosts.status, 'rejected'),
          isNotNull(processedPosts.sourceText),
        ),
      )
      .orderBy(desc(processedPosts.reviewedAt))
      .limit(input.perClass),
    db
      .select({
        decisions: count(),
        approvals: sql<number>`count(*) FILTER (WHERE ${inArray(processedPosts.status, [...APPROVED_STATUSES])})`.mapWith(Number),
      })
      .from(processedPosts)
      .where(and(decidedBefore, inArray(processedPosts.status, [...APPROVED_STATUSES, 'rejected']))),
  ]);

  const toExample = (row: (typeof approved)[number]): RadarExample => ({
    postId: row.id,
    sourceUsername: row.sourceUsername ?? 'unknown',
    text: row.sourceText ?? '',
    media: describeStoredMedia(row.method, row.mediaCount),
    decision: row.status === 'rejected' ? 'reject' : 'approve',
    rejectionReason: row.rejectionReason,
    rejectionNote: row.rejectionNote,
  });

  const decisions = totals?.decisions ?? 0;
  return {
    examples: [...approved.map(toExample), ...rejected.map(toExample)],
    approvalRate: decisions > 0 ? (totals!.approvals ?? 0) / decisions : null,
    decisions,
  };
}

/**
 * Variants this post already has a row for under this setup, so none is scored
 * twice. With `scoredOnly`, a failed or skipped attempt does not count — the
 * backfill retries those.
 */
export async function findEvaluatedVariants(
  db: Database,
  input: {
    processedPostId: number;
    mode: RadarMode;
    model: string;
    promptVersion: string;
    scoredOnly?: boolean;
  },
): Promise<Set<RadarVariant>> {
  const rows = await db
    .select({ variant: radarEvaluations.variant })
    .from(radarEvaluations)
    .where(
      and(
        eq(radarEvaluations.processedPostId, input.processedPostId),
        eq(radarEvaluations.mode, input.mode),
        eq(radarEvaluations.model, input.model),
        eq(radarEvaluations.promptVersion, input.promptVersion),
        input.scoredOnly ? eq(radarEvaluations.status, 'ok') : undefined,
      ),
    );
  return new Set(rows.map((row) => row.variant));
}

/** Record an attempt. A duplicate — a second run racing the first — is ignored. */
export async function insertRadarEvaluation(
  db: Database,
  row: typeof radarEvaluations.$inferInsert,
): Promise<void> {
  await db.insert(radarEvaluations).values(row).onConflictDoNothing();
}

/**
 * Record a backfill result. It replaces an earlier failed attempt at the same
 * score, but never a score that came back: re-reading a batch changes nothing.
 */
export async function recordBackfillEvaluation(
  db: Database,
  row: typeof radarEvaluations.$inferInsert,
): Promise<void> {
  await db
    .insert(radarEvaluations)
    .values(row)
    .onConflictDoUpdate({
      target: [
        radarEvaluations.processedPostId,
        radarEvaluations.mode,
        radarEvaluations.variant,
        radarEvaluations.model,
        radarEvaluations.promptVersion,
      ],
      // Every result column, so nothing of the failed attempt survives.
      set: {
        status: row.status,
        score: row.score ?? null,
        predictedDecision: row.predictedDecision ?? null,
        topicFit: row.topicFit ?? null,
        editorialFit: row.editorialFit ?? null,
        importance: row.importance ?? null,
        reason: row.reason ?? null,
        predictedRejectionReason: row.predictedRejectionReason ?? null,
        imageIncluded: row.imageIncluded ?? false,
        examplePostIds: row.examplePostIds ?? [],
        inputTokens: row.inputTokens ?? null,
        outputTokens: row.outputTokens ?? null,
        latencyMs: row.latencyMs ?? null,
        error: row.error ?? null,
        publicationHistoryProfileId: row.publicationHistoryProfileId ?? null,
        historyRetrieval: row.historyRetrieval ?? null,
        historicalAssessment: row.historicalAssessment ?? null,
        createdAt: new Date(),
      },
      where: ne(radarEvaluations.status, 'ok'),
    });
}
