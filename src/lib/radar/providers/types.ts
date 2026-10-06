import type { z } from 'zod';
import type { RadarInput, RadarPrediction, TokenUsage } from '@/lib/radar/output';

export const RADAR_PROVIDERS = ['openai', 'anthropic'] as const;
export type RadarProviderName = (typeof RADAR_PROVIDERS)[number];

/** One batch result, tied back to its request by custom id. */
export type RadarBatchResult =
  | { customId: string; ok: true; prediction: RadarPrediction }
  | { customId: string; ok: false; error: string; usage?: TokenUsage };

/** A one-off request for a structured answer, outside scoring. */
export interface CompletionRequest<T> {
  instructions: string;
  input: string;
  /** The answer's shape: sent to constrain the model, and checked again on return. */
  schema: z.ZodType<T>;
  /** A name for that shape, which some providers require. */
  schemaName: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

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

  /**
   * Any other structured answer from the same model — e.g. profiling a
   * channel's publication history. Throws RadarError on a refused, cut-off or
   * malformed answer.
   */
  complete<T>(request: CompletionRequest<T>): Promise<{ output: T; usage: TokenUsage }>;

  /** One batch request, as JSON the batch will carry — also how its size is judged. */
  batchEntry(customId: string, input: RadarInput): unknown;
  submitBatch(entries: unknown[]): Promise<string>;
  pollBatch(batchId: string): Promise<{ ended: boolean; status: string }>;
  batchResults(batchId: string): AsyncIterable<RadarBatchResult>;
}
