import { z } from 'zod';
import { REJECTION_REASONS, type RejectionReason } from '@/db/schema';
import type { RadarExample, RadarImage, RadarItem } from '@/lib/radar/prompt';

/**
 * What Radar answers, whichever model gives the answer.
 *
 * Each provider constrains the model to this schema and the answer is checked
 * against it again here. The fields are in the order the model fills them in
 * — the reason first, the score last — so the score follows from what it has
 * just said.
 */
export const radarOutputSchema = z.object({
  reason: z.string(),
  topic_fit: z.number().int(),
  editorial_fit: z.number().int(),
  importance: z.number().int(),
  predicted_rejection_reason: z.enum(REJECTION_REASONS).nullable(),
  predicted_decision: z.enum(['approve', 'reject']),
  score: z.number().int(),
});

export type RadarOutput = z.infer<typeof radarOutputSchema>;

export interface RadarInput {
  profile: string;
  approvalRate: number | null;
  item: RadarItem;
  examples: RadarExample[];
  image?: RadarImage;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface RadarPrediction extends TokenUsage {
  score: number;
  predictedDecision: 'approve' | 'reject';
  topicFit: number;
  editorialFit: number;
  importance: number;
  reason: string;
  predictedRejectionReason: RejectionReason | null;
}

export class RadarError extends Error {
  constructor(
    message: string,
    readonly usage?: TokenUsage,
  ) {
    super(message);
    this.name = 'RadarError';
  }
}

/** Check the model's JSON text against the schema and turn it into a prediction. */
export function toPrediction(text: string, usage: TokenUsage): RadarPrediction {
  let output: RadarOutput;
  try {
    output = radarOutputSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new RadarError(`answer did not match the schema: ${(error as Error).message}`, usage);
  }

  return {
    // No provider enforces numeric ranges, so they are enforced here.
    score: clampPercent(output.score),
    predictedDecision: output.predicted_decision,
    topicFit: clampPercent(output.topic_fit),
    editorialFit: clampPercent(output.editorial_fit),
    importance: clampPercent(output.importance),
    reason: output.reason.trim().slice(0, 500),
    predictedRejectionReason:
      output.predicted_decision === 'reject' ? output.predicted_rejection_reason : null,
    ...usage,
  };
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}
