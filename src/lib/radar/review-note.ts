import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import { radarEvaluations } from '@/db/schema';
import { RADAR_PROMPT_APPROVED, RADAR_PROMPT_BASELINE, RADAR_PROMPT_RETRIEVAL } from '@/lib/radar/prompt';

/**
 * Radar's score on the message with the review buttons: a hint for the
 * reviewer, never a filter — every post still comes to review, whatever it
 * scored, and nothing is decided for them.
 *
 * Of the live scores a post has, the one shown is from the prompt version
 * that has matched the editor best so far (radar:report), on the text alone,
 * which has separated better live than text with the image.
 */

/** Most trusted first. */
const SHOWN_VERSIONS = [RADAR_PROMPT_APPROVED, RADAR_PROMPT_RETRIEVAL, RADAR_PROMPT_BASELINE];

/** Long enough for Radar's one-line why, short enough to stay under the buttons' URL. */
const REASON_MAX = 200;

export interface ReviewScore {
  score: number;
  predictedDecision: 'approve' | 'reject';
  reason: string | null;
  possiblyAlreadyCovered: boolean;
}

/** The live score to show for a post, or null when Radar has none for it. */
export async function findReviewScore(db: Database, processedPostId: number): Promise<ReviewScore | null> {
  const rank = sql`case ${radarEvaluations.promptVersion} ${sql.join(
    SHOWN_VERSIONS.map((version, index) => sql`when ${version} then ${index}`),
    sql` `,
  )} else ${SHOWN_VERSIONS.length} end`;

  const [row] = await db
    .select({
      score: radarEvaluations.score,
      predictedDecision: radarEvaluations.predictedDecision,
      reason: radarEvaluations.reason,
      historicalAssessment: radarEvaluations.historicalAssessment,
    })
    .from(radarEvaluations)
    .where(
      and(
        eq(radarEvaluations.processedPostId, processedPostId),
        eq(radarEvaluations.mode, 'live'),
        eq(radarEvaluations.status, 'ok'),
      ),
    )
    .orderBy(
      rank,
      sql`case ${radarEvaluations.variant} when 'text' then 0 else 1 end`,
      desc(radarEvaluations.createdAt),
    )
    .limit(1);

  if (!row || row.score === null || !row.predictedDecision) return null;
  return {
    score: row.score,
    predictedDecision: row.predictedDecision,
    reason: row.reason?.trim() || null,
    possiblyAlreadyCovered: row.historicalAssessment?.possiblyAlreadyCovered === true,
  };
}

/**
 * The note as plain text — the review message escapes it, so a model's words
 * can never become markup — or null for none.
 */
export function formatRadarNote(score: ReviewScore | null): string | null {
  if (!score) return null;

  const verdict = score.predictedDecision === 'approve' ? 'likely approve' : 'likely reject';
  const lines = [`📡 Radar ${score.score}/100 · ${verdict}`];
  if (score.possiblyAlreadyCovered) lines.push('♻️ May already be covered in the channel');
  if (score.reason) {
    lines.push(score.reason.length > REASON_MAX ? `${score.reason.slice(0, REASON_MAX - 1).trimEnd()}…` : score.reason);
  }
  return lines.join('\n');
}

/** Look up and format in one go, for a review message re-rendered after the fact. */
export async function loadRadarNote(db: Database, processedPostId: number): Promise<string | null> {
  return formatRadarNote(await findReviewScore(db, processedPostId));
}
