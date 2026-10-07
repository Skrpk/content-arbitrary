import { and, eq } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import {
  processedPosts,
  radarEvaluations,
  type HistoricalAssessment,
  type HistoryRetrievalRecord,
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
  /** The publication-history profile the prompt carried, if any. */
  publicationHistoryProfileId: number | null;
  /** Retrieval prompt only: what the similar-publication search found. */
  historyRetrieval: HistoryRetrievalRecord | null;
  historicalAssessment: HistoricalAssessment | null;
  /** The editor's decision; null while the post is undecided. */
  approved: boolean | null;
  /** Why the editor turned it down, if they did. */
  rejectionReason: string | null;
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

/** List-price cost in USD of `usage` on `model`, or null for a model not priced here. */
export function costUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number },
  options: { batch?: boolean } = {},
): number | null {
  const price = PRICE_PER_MILLION[model];
  if (!price) return null;
  const cost = (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
  return options.batch ? cost * 0.5 : cost;
}

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
      publicationHistoryProfileId: radarEvaluations.publicationHistoryProfileId,
      historyRetrieval: radarEvaluations.historyRetrieval,
      historicalAssessment: radarEvaluations.historicalAssessment,
      rejectionReason: processedPosts.rejectionReason,
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
    const key = [row.mode, row.variant, row.model, row.promptVersion, historyLabel(row)].join(' · ');
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

  const retrieval = formatRetrieval(rows);
  if (retrieval) lines.push('', ...retrieval);

  const inputTokens = sum(rows.map((row) => row.inputTokens ?? 0));
  const outputTokens = sum(rows.map((row) => row.outputTokens ?? 0));
  // The backfill goes through the batch APIs, billed at half the list price.
  const batch = rows[0]!.mode === 'backfill';
  const cost = costUsd(rows[0]!.model, { inputTokens, outputTokens }, { batch });
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
  const setups = new Set(rows.map(setupOf));

  for (const setupKey of [...setups].sort()) {
    const inSetup = usable(rows).filter((row) => setupOf(row) === setupKey);
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
 * How the similar-publication search went for a retrieval prompt's rows, and
 * how its "possibly already covered" flag lines up with the editor's
 * already_covered rejections.
 */
function formatRetrieval(rows: ReportRow[]): string[] | null {
  const searched = rows.filter((row) => row.historyRetrieval !== null);
  if (searched.length === 0) return null;

  const byStatus = new Map<string, number>();
  for (const row of searched) {
    const status = row.historyRetrieval!.status;
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
  }
  const top = searched
    .map((row) => row.historyRetrieval!.matches[0]?.similarity)
    .filter((value): value is number => value !== undefined);
  const lines = [
    `History retrieval: ${[...byStatus.entries()].map(([status, total]) => `${status} ${total}`).join(', ')}` +
      (top.length > 0 ? ` · top similarity median ${median(top).toFixed(2)}` : ''),
  ];

  const withApproved = searched.filter((row) => row.historyRetrieval!.approved);
  if (withApproved.length > 0) {
    const approvedStatus = new Map<string, number>();
    for (const row of withApproved) {
      const status = row.historyRetrieval!.approved!.status;
      approvedStatus.set(status, (approvedStatus.get(status) ?? 0) + 1);
    }
    const topApproved = withApproved
      .map((row) => row.historyRetrieval!.approved!.matches[0]?.similarity)
      .filter((value): value is number => value !== undefined);
    lines.push(
      `Approved-post retrieval: ${[...approvedStatus.entries()].map(([status, total]) => `${status} ${total}`).join(', ')}` +
        (topApproved.length > 0 ? ` · top similarity median ${median(topApproved).toFixed(2)}` : ''),
    );
  }

  const decided = usable(rows);
  const flagged = decided.filter((row) => row.historicalAssessment?.possiblyAlreadyCovered);
  const repeats = decided.filter((row) => row.rejectionReason === 'already_covered');
  if (flagged.length > 0 || repeats.length > 0) {
    const flaggedRepeats = flagged.filter((row) => row.rejectionReason === 'already_covered').length;
    lines.push(
      `Flagged "possibly already covered": ${flagged.length} — ` +
        `${flagged.filter((row) => !row.approved).length} rejected, ${flaggedRepeats} of them as already_covered; ` +
        `editor's already_covered rejections: ${repeats.length}, flagged ${flaggedRepeats}`,
    );
  }
  return lines;
}

/**
 * Two prompt versions on exactly the posts both scored, per mode, variant and
 * model — the only comparison that says what the difference between the
 * prompts did, rather than what the difference between two sets of posts did.
 */
export function formatPromptComparison(rows: ReportRow[], versions: [string, string]): string {
  const [first, second] = versions;
  const sections: string[] = [];
  const setups = new Set(
    rows.filter((row) => versions.includes(row.promptVersion)).map((row) => [row.mode, row.variant, row.model].join(' · ')),
  );

  for (const setupKey of [...setups].sort()) {
    const inSetup = usable(rows).filter((row) => [row.mode, row.variant, row.model].join(' · ') === setupKey);
    const byPost = (version: string) =>
      new Map(inSetup.filter((row) => row.promptVersion === version).map((row) => [row.processedPostId, row]));
    const a = byPost(first);
    const b = byPost(second);
    const posts = [...a.keys()].filter((id) => b.has(id));
    if (posts.length === 0) continue;

    const sides = [posts.map((id) => a.get(id)!), posts.map((id) => b.get(id)!)];
    const approvedCount = sides[0]!.filter((row) => row.approved).length;
    const column = (values: string[]) => values.map((value) => value.padStart(14)).join('');
    const line = (label: string, compute: (side: ReportRow[]) => string) =>
      `${label.padEnd(30)}${column(sides.map(compute))}`;

    const lines = [
      `== ${first} vs ${second} · ${setupKey}`,
      `Same ${posts.length} posts, ${approvedCount} approved, ${posts.length - approvedCount} rejected`,
      `${''.padEnd(30)}${column(['A', 'B'])}`,
      line('Separation (AUC)', (side) => {
        const approved = side.filter((row) => row.approved).map((row) => row.score!);
        const rejected = side.filter((row) => !row.approved).map((row) => row.score!);
        return approved.length > 0 && rejected.length > 0 ? auc(approved, rejected).toFixed(2) : 'n/a';
      }),
      line('Mean score, approved', (side) => meanOf(side.filter((row) => row.approved))),
      line('Mean score, rejected', (side) => meanOf(side.filter((row) => !row.approved))),
      line('Precision@80', (side) => {
        const high = side.filter((row) => row.score! >= 80);
        return `${high.filter((row) => row.approved).length}/${high.length} ${percent(high.filter((row) => row.approved).length, high.length)}`;
      }),
      ...THRESHOLDS.map((threshold) =>
        line(`Recall@${threshold} · work saved`, (side) => {
          const kept = side.filter((row) => row.approved && row.score! >= threshold).length;
          const hidden = side.filter((row) => row.score! < threshold).length;
          return `${percent(kept, approvedCount)} · ${percent(hidden, side.length)}`;
        }),
      ),
      line('Missed approvals (<50)', (side) => String(side.filter((row) => row.approved && row.score! < 50).length)),
      line('Tokens in / out', (side) => {
        const input = sum(side.map((row) => row.inputTokens ?? 0));
        const output = sum(side.map((row) => row.outputTokens ?? 0));
        return `${Math.round(input / 1000)}k/${Math.round(output / 1000)}k`;
      }),
      line('Cost', (side) => {
        const cost = costUsd(
          side[0]!.model,
          { inputTokens: sum(side.map((row) => row.inputTokens ?? 0)), outputTokens: sum(side.map((row) => row.outputTokens ?? 0)) },
          { batch: side[0]!.mode === 'backfill' },
        );
        return cost === null ? 'n/a' : `$${cost.toFixed(4)}`;
      }),
      `A = ${first}, B = ${second}`,
    ];

    const missed = (side: ReportRow[]) =>
      side.filter((row) => row.approved && row.score! < 50).map((row) => row.processedPostId);
    const missedA = new Set(missed(sides[0]!));
    const missedB = new Set(missed(sides[1]!));
    const fixed = [...missedA].filter((id) => !missedB.has(id));
    const broke = [...missedB].filter((id) => !missedA.has(id));
    if (fixed.length > 0 || broke.length > 0) {
      lines.push(
        `Approvals B rescued from <50: ${fixed.length > 0 ? fixed.join(', ') : 'none'}; ` +
          `newly missed by B: ${broke.length > 0 ? broke.join(', ') : 'none'}`,
      );
    }
    sections.push(lines.join('\n'));
  }

  return sections.length > 0
    ? sections.join('\n\n')
    : `No posts decided and scored by both ${first} and ${second} yet.`;
}

function meanOf(rows: ReportRow[]): string {
  return rows.length === 0 ? 'n/a' : mean(rows.map((row) => row.score!)).toFixed(1);
}

/**
 * Everything that shaped a score except the variant. Scores made with
 * different context — another prompt, another history profile or none — are
 * never pooled.
 */
function setupOf(row: ReportRow): string {
  return [row.mode, row.model, row.promptVersion, historyLabel(row)].join(' · ');
}

function historyLabel(row: ReportRow): string {
  return row.publicationHistoryProfileId === null
    ? 'no history profile'
    : `history profile #${row.publicationHistoryProfileId}`;
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
