import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import { radarEvaluations } from '@/db/schema';
import { RADAR_PROMPT_BASELINE, RADAR_PROMPT_REJECTED, RADAR_PROMPT_RETRIEVAL } from '@/lib/radar/prompt';
import { findRepeat, formatRepeatNote, type Repeat } from '@/lib/stories/repeats';

/**
 * Radar's score on the message with the review buttons, and the order of the
 * review queue: a hint for the reviewer, never a filter — every post still
 * comes to review, whatever it scored, and nothing is decided for them.
 *
 * Of the live scores a post has, the one shown first — and the one the queue
 * and the digest's recommendations follow — is from the prompt version that
 * has matched the editor best so far (radar:report), on the text alone, which
 * has separated better live than text with the image. That is v5: on the same
 * live posts it put 19 of 33 approvals in each day's top, where v3 put 8.
 *
 * v3 is still scored live, so the two can go on being compared in the report,
 * but it is neither shown nor sorted by: its scale is higher than v5's, and a
 * post scored only by it would jump the queue. Versions to set beside the
 * first, each under its own name, go in COMPARED_VERSIONS.
 */

/** Most trusted first; the next one only where a post has none of those before it. */
const SHOWN_VERSIONS = [RADAR_PROMPT_REJECTED, RADAR_PROMPT_RETRIEVAL, RADAR_PROMPT_BASELINE];
/** Shown beside the first, each under its own name. None while v5 is the one shown. */
const COMPARED_VERSIONS: string[] = [];

/** Long enough for Radar's one-line why, short enough to stay under the buttons' URL. */
const REASON_MAX = 200;

export interface VersionScore {
  /** The prompt version it came from, short: `v3`. */
  version: string;
  score: number;
  predictedDecision: 'approve' | 'reject';
  reason: string | null;
  possiblyAlreadyCovered: boolean;
}

export interface ReviewScore extends VersionScore {
  /** The compared versions' scores for the same post, in COMPARED_VERSIONS order; empty when none. */
  compared: VersionScore[];
}

/** `radar-v5-similar-rejected` → `v5`. */
export function shortVersion(promptVersion: string): string {
  return /^radar-(v\d+)/.exec(promptVersion)?.[1] ?? promptVersion;
}

/** The live score to show for a post, or null when Radar has none for it. */
export async function findReviewScore(db: Database, processedPostId: number): Promise<ReviewScore | null> {
  return (await findReviewScores(db, [processedPostId])).get(processedPostId) ?? null;
}

/** The live score to show for each of several posts, in one query; a post Radar has none for is absent. */
export async function findReviewScores(db: Database, processedPostIds: number[]): Promise<Map<number, ReviewScore>> {
  const scores = new Map<number, ReviewScore>();
  if (processedPostIds.length === 0) return scores;

  // The best row per post and version: DISTINCT ON keeps the first of each in this order.
  const rows = await db
    .selectDistinctOn([radarEvaluations.processedPostId, radarEvaluations.promptVersion], {
      processedPostId: radarEvaluations.processedPostId,
      promptVersion: radarEvaluations.promptVersion,
      score: radarEvaluations.score,
      predictedDecision: radarEvaluations.predictedDecision,
      reason: radarEvaluations.reason,
      historicalAssessment: radarEvaluations.historicalAssessment,
    })
    .from(radarEvaluations)
    .where(
      and(
        inArray(radarEvaluations.processedPostId, processedPostIds),
        inArray(radarEvaluations.promptVersion, [...SHOWN_VERSIONS, ...COMPARED_VERSIONS]),
        eq(radarEvaluations.mode, 'live'),
        eq(radarEvaluations.status, 'ok'),
        isNotNull(radarEvaluations.score),
        isNotNull(radarEvaluations.predictedDecision),
      ),
    )
    .orderBy(
      radarEvaluations.processedPostId,
      radarEvaluations.promptVersion,
      sql`case ${radarEvaluations.variant} when 'text' then 0 else 1 end`,
      desc(radarEvaluations.createdAt),
    );

  const byPost = new Map<number, Map<string, VersionScore>>();
  for (const row of rows) {
    if (row.processedPostId === null || row.score === null || !row.predictedDecision) continue;
    const versions = byPost.get(row.processedPostId) ?? new Map<string, VersionScore>();
    versions.set(row.promptVersion, {
      version: shortVersion(row.promptVersion),
      score: row.score,
      predictedDecision: row.predictedDecision,
      reason: row.reason?.trim() || null,
      possiblyAlreadyCovered: row.historicalAssessment?.possiblyAlreadyCovered === true,
    });
    byPost.set(row.processedPostId, versions);
  }

  for (const [postId, versions] of byPost) {
    const first = [...SHOWN_VERSIONS, ...COMPARED_VERSIONS].find((version) => versions.has(version))!;
    const compared = COMPARED_VERSIONS.filter((version) => version !== first && versions.has(version)).map(
      (version) => versions.get(version)!,
    );
    scores.set(postId, { ...versions.get(first)!, compared });
  }
  return scores;
}

/**
 * The note as plain text — the review message escapes it, so a model's words
 * can never become markup — or null for none. A repeat is said under it, or
 * alone when Radar has no score.
 */
export function formatRadarNote(score: ReviewScore | null, repeat: Repeat | null = null): string | null {
  const repeatLine = formatRepeatNote(repeat);
  if (!score) return repeatLine;

  const lines = [score, ...score.compared].flatMap((version) => {
    const verdict = version.predictedDecision === 'approve' ? 'likely approve' : 'likely reject';
    return [
      `📡 Radar ${version.version}: ${version.score}/100 · ${verdict}`,
      ...(version.possiblyAlreadyCovered ? ['♻️ May already be covered in the channel'] : []),
      ...(version.reason
        ? [version.reason.length > REASON_MAX ? `${version.reason.slice(0, REASON_MAX - 1).trimEnd()}…` : version.reason]
        : []),
    ];
  });
  if (repeatLine) lines.push(repeatLine);
  return lines.join('\n');
}

/** Look up and format in one go, for a review message re-rendered after the fact. */
export async function loadRadarNote(db: Database, processedPostId: number): Promise<string | null> {
  const [score, repeat] = await Promise.all([findReviewScore(db, processedPostId), findRepeat(db, processedPostId)]);
  return formatRadarNote(score, repeat);
}
