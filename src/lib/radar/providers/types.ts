import type { RadarInput, RadarPrediction, TokenUsage } from '@/lib/radar/output';

export const RADAR_PROVIDERS = ['openai', 'anthropic'] as const;
export type RadarProviderName = (typeof RADAR_PROVIDERS)[number];

/** One batch result, tied back to its request by custom id. */
export type RadarBatchResult =
  | { customId: string; ok: true; prediction: RadarPrediction }
  | { customId: string; ok: false; error: string; usage?: TokenUsage };

/**
 * A model Radar can ask, now or in a batch. Everything provider-specific —
 * request format, structured output, image encoding, batch mechanics — stays
 * behind this; the rest of Radar sees only predictions.
 */
export interface RadarProvider {
  readonly name: RadarProviderName;
  /** Recorded with every score, so the report keeps models apart. */
  readonly model: string;

  score(input: RadarInput, options: { timeoutMs: number }): Promise<RadarPrediction>;

  /** One batch request, as JSON the batch will carry — also how its size is judged. */
  batchEntry(customId: string, input: RadarInput): unknown;
  submitBatch(entries: unknown[]): Promise<string>;
  pollBatch(batchId: string): Promise<{ ended: boolean; status: string }>;
  batchResults(batchId: string): AsyncIterable<RadarBatchResult>;
}
