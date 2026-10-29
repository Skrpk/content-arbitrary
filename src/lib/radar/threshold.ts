/**
 * A source's Radar threshold: posts Radar scores under it are passed over
 * before review, never reaching the queue or the chat.
 *
 * The one place Radar decides rather than orders, and only where the editor
 * set a threshold for the source. A post Radar has no score for — it failed,
 * timed out, ran out of the run's budget — goes to review as always.
 *
 * Passed over is recorded as `skipped`, with a reason starting with
 * RADAR_THRESHOLD_REASON_PREFIX — not as `rejected`: no one turned it down,
 * so it is not a decision Radar may learn from or be measured against.
 */

export const RADAR_THRESHOLD_MIN = 1;
export const RADAR_THRESHOLD_MAX = 100;

export const RADAR_THRESHOLD_REASON_PREFIX = 'radar threshold: ';

/** The reason recorded for a post passed over, or null when it goes to review. */
export function belowThresholdReason(score: number | null | undefined, threshold: number | null): string | null {
  if (threshold === null || score === null || score === undefined || score >= threshold) return null;
  return `${RADAR_THRESHOLD_REASON_PREFIX}scored ${score}, under the source's ${threshold}`;
}
