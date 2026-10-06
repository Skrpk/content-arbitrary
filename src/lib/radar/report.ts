import { and, eq } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import {
  processedPosts,
  radarEvaluations,
  type RadarMode,
  type RadarStatus,
  type RadarVariant,
} from '@/db/schema';
import { ANTHROPIC_RADAR_MODEL, OPENAI_RADAR_MODEL } from '@/lib/radar/providers';

/**
 * How well Radar's scores match the editor's decisions.
 *
 * Accuracy is deliberately absent: with roughly one post in four approved, a
 * model that rejects everything is 75% "accurate" and useless. What matters is
 * whether approved posts score higher than rejected ones, and how much review
 * work a threshold would save for how much good content it would hide.
 */

export interface ReportRow {
  processedPostId: number;
  mode: RadarMode;
  variant: RadarVariant;
  model: string;
  promptVersion: string;
  status: RadarStatus;
  score: number | null;
  predictedDecision: 'approve' | 'reject' | null;
  imageIncluded: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  evaluatedAt: Date;
  /** The editor's decision; null while the post is undecided. */
  approved: boolean | null;
  reviewedAt: Date | null;
}

/**
 * List prices, USD per million tokens, for Radar's default models. Input is
 * priced uncached, so a run that hit a provider's prompt cache cost a little
 * less than reported. A model not listed here is reported without a cost.
 */
const PRICE_PER_MILLION: Record<string, { input: number; output: number }> = {
  [OPENAI_RADAR_MODEL]: { input: 0.1, output: 0.5 },
  [ANTHROPIC_RADAR_MODEL]: { input: 1, output: 5 },
};

const BUCKETS = [
  { label: '90-100', min: 90, max: 100 },
  { label: '75-89', min: 75, max: 89 },
  { label: '50-74', min: 50, max: 74 },
  { label: '25-49', min: 25, max: 49 },
  { label: '0-24', min: 0, max: 24 },
];

const THRESHOLDS = [30, 40, 50, 60];

export async function loadReportRows(db: Database, workspaceId: number): Promise<ReportRow[]> {
  const rows = await db
    .select({
      processedPostId: radarEvaluations.processedPostId,
      mode: radarEvaluations.mode,
      variant: radarEvaluations.variant,
      model: radarEvaluations.model,
      promptVersion: radarEvaluations.promptVersion,
      status: radarEvaluations.status,
      score: radarEvaluations.score,
      predictedDecision: radarEvaluations.predictedDecision,
      imageIncluded: radarEvaluations.imageIncluded,
      inputTokens: radarEvaluations.inputTokens,
      outputTokens: radarEvaluations.outputTokens,
      evaluatedAt: radarEvaluations.createdAt,
      postStatus: processedPosts.status,
      reviewedAt: processedPosts.reviewedAt,
    })
    .from(radarEvaluations)
    .innerJoin(processedPosts, eq(processedPosts.id, radarEvaluations.processedPostId))
    .where(and(eq(radarEvaluations.workspaceId, workspaceId)));

  return rows.map(({ postStatus, ...row }) => ({
    ...row,
    approved:
      row.reviewedAt === null
        ? null
        : postStatus === 'published' || postStatus === 'scheduled'
          ? true
          : postStatus === 'rejected'
            ? false
            : null,
  }));
}

export function formatRadarReport(rows: ReportRow[]): string {
  if (rows.length === 0) return 'No Radar evaluations yet.';

  const groups = new Map<string, ReportRow[]>();
  for (const row of rows) {
    const key = [row.mode, row.variant, row.model, row.promptVersion].join(' · ');
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const sections = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => formatGroup(key, group));

  const paired = formatPairedComparison(rows);
  return [...sections, ...(paired ? [paired] : [])].join('\n\n');
}

function formatGroup(key: string, rows: ReportRow[]): string {
  const failed = rows.filter((row) => row.status === 'failed').length;
  const skipped = rows.filter((row) => row.status === 'skipped').length;
  const scored = usable(rows);

  const lines = [`== ${key}`];
  lines.push(
    `Attempts: ${rows.length} · scored ${rows.length - failed - skipped} · failed ${failed} · skipped ${skipped}`,
  );

  const live = rows[0]?.mode === 'live';
  lines.push(
    `Decided and counted: ${scored.length}` +
      (live ? ' (only scores made before the decision)' : ''),
  );

  if (scored.length > 0) {
    const approved = scored.filter((row) => row.approved);
    const rejected = scored.filter((row) => !row.approved);
    lines.push(
      `Editor approved: ${approved.length} of ${scored.length} (${percent(approved.length, scored.length)})`,
    );

    if (approved.length > 0 && rejected.length > 0) {
      const approvedScores = approved.map((row) => row.score!);
      const rejectedScores = rejected.map((row) => row.score!);
      lines.push(
        `Score, approved: mean ${mean(approvedScores).toFixed(1)}, median ${median(approvedScores)}`,
        `Score, rejected: mean ${mean(rejectedScores).toFixed(1)}, median ${median(rejectedScores)}`,
        `Separation (AUC): ${auc(approvedScores, rejectedScores).toFixed(2)}  — 0.50 is chance, 1.00 perfect`,
      );
    }

    const predictedApprove = scored.filter((row) => row.predictedDecision === 'approve');
    const hits = predictedApprove.filter((row) => row.approved).length;
    lines.push(
      `Predicted "approve": ${predictedApprove.length} — right ${percent(hits, predictedApprove.length)}, ` +
        `caught ${hits} of ${approved.length} approvals (${percent(hits, approved.length)})`,
    );

    const high = scored.filter((row) => row.score! >= 80);
    const keptAt50 = approved.filter((row) => row.score! >= 50).length;
    lines.push(
      `Precision@80: ${percent(high.filter((row) => row.approved).length, high.length)} of ${high.length} posts · ` +
        `Recall@50: ${keptAt50} of ${approved.length} (${percent(keptAt50, approved.length)})`,
    );

    lines.push('', 'Score     posts  approved  rate');
    for (const bucket of BUCKETS) {
      const inBucket = scored.filter((row) => row.score! >= bucket.min && row.score! <= bucket.max);
      const ok = inBucket.filter((row) => row.approved).length;
      lines.push(
        `${bucket.label.padEnd(8)}  ${String(inBucket.length).padStart(5)}  ${String(ok).padStart(8)}  ${percent(ok, inBucket.length).padStart(5)}`,
      );
    }

    lines.push('', 'If only posts at or above a threshold were shown:');
    for (const threshold of THRESHOLDS) {
      const shown = scored.filter((row) => row.score! >= threshold);
      const kept = shown.filter((row) => row.approved).length;
      lines.push(
        `  >= ${threshold}: shown ${shown.length} of ${scored.length}, ` +
          `review work saved ${percent(scored.length - shown.length, scored.length)}, ` +
          `approved kept ${kept} of ${approved.length} (${percent(kept, approved.length)})`,
      );
    }
  }

  const inputTokens = sum(rows.map((row) => row.inputTokens ?? 0));
  const outputTokens = sum(rows.map((row) => row.outputTokens ?? 0));
  const price = PRICE_PER_MILLION[rows[0]!.model];
  // The backfill goes through the batch APIs, billed at half the list price.
  const batch = rows[0]!.mode === 'backfill';
  const cost = price
    ? ((inputTokens * price.input + outputTokens * price.output) / 1_000_000) * (batch ? 0.5 : 1)
    : null;
  lines.push(
    '',
    `Tokens: ${inputTokens} in, ${outputTokens} out` +
      (cost === null ? '' : ` ≈ $${cost.toFixed(2)}${batch ? ' (batch price)' : ''}`),
  );

  return lines.join('\n');
}

/**
 * Text against text-and-image, on exactly the posts both scored — otherwise
 * the comparison would be between two different sets of posts.
 */
function formatPairedComparison(rows: ReportRow[]): string | null {
  const lines: string[] = [];
  const setups = new Set(rows.map((row) => [row.mode, row.model, row.promptVersion].join(' · ')));

  for (const setupKey of [...setups].sort()) {
    const inSetup = usable(rows).filter(
      (row) => [row.mode, row.model, row.promptVersion].join(' · ') === setupKey,
    );
    const textByPost = new Map(
      inSetup.filter((row) => row.variant === 'text').map((row) => [row.processedPostId, row]),
    );
    const pairs = inSetup
      .filter((row) => row.variant === 'text_image' && row.imageIncluded)
      .map((withImage) => ({ withImage, text: textByPost.get(withImage.processedPostId) }))
      .filter((pair): pair is { withImage: ReportRow; text: ReportRow } => pair.text !== undefined);

    if (pairs.length === 0) continue;

    const separation = (pick: (pair: (typeof pairs)[number]) => ReportRow) => {
      const approved = pairs.filter((pair) => pick(pair).approved).map((pair) => pick(pair).score!);
      const rejected = pairs.filter((pair) => !pick(pair).approved).map((pair) => pick(pair).score!);
      return approved.length > 0 && rejected.length > 0 ? auc(approved, rejected).toFixed(2) : 'n/a';
    };

    const approvedCount = pairs.filter((pair) => pair.text.approved).length;
    lines.push(
      `== text vs text_image · ${setupKey}`,
      `Same ${pairs.length} posts with an image (${approvedCount} approved):`,
      `  AUC text only:      ${separation((pair) => pair.text)}`,
      `  AUC text + image:   ${separation((pair) => pair.withImage)}`,
    );
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Scored rows with a decision to compare against. A live score counts only
 * if it was made before the decision; afterwards it is not a prediction.
 */
function usable(rows: ReportRow[]): ReportRow[] {
  return rows.filter(
    (row) =>
      row.status === 'ok' &&
      row.score !== null &&
      row.approved !== null &&
      (row.mode !== 'live' || (row.reviewedAt !== null && row.evaluatedAt < row.reviewedAt)),
  );
}

/** Probability that a random approved post outscores a random rejected one; ties count half. */
export function auc(approved: number[], rejected: number[]): number {
  let wins = 0;
  for (const a of approved) {
    for (const r of rejected) wins += a > r ? 1 : a === r ? 0.5 : 0;
  }
  return wins / (approved.length * rejected.length);
}

function mean(values: number[]): number {
  return sum(values) / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function percent(part: number, whole: number): string {
  return whole === 0 ? 'n/a' : `${Math.round((part / whole) * 100)}%`;
}
