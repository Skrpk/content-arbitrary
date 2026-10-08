import { z } from 'zod';
import { REJECTION_REASONS, type HistoricalAssessment, type RejectionReason } from '@/db/schema';
import type { PublicationProfile } from '@/lib/history/profile/schema';
import type {
  RadarExample,
  RadarImage,
  RadarItem,
  RadarPromptVersion,
  RadarMediaContext,
  RadarSimilarApproved,
  RadarSimilarPublication,
} from '@/lib/radar/prompt';
import { truncateToLength } from '@/lib/telegram/format-caption';

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

const historicalContextSchema = z.object({
  relevant: z.boolean(),
  possibly_already_covered: z.boolean(),
  explanation: z.string(),
});

/**
 * The retrieval prompt's answer: the same, with what the similar past
 * publications show first — before the reason, so the score follows from it.
 */
export const radarRetrievalOutputSchema = z.object({
  historical_context: historicalContextSchema.nullable(),
  ...radarOutputSchema.shape,
});

/**
 * What any answer is read with, whichever version asked: a batch result
 * arrives without its request, and the baseline's answer simply has no
 * historical_context.
 */
const anyRadarOutputSchema = radarOutputSchema.extend({
  historical_context: historicalContextSchema.nullable().optional(),
});

export interface RadarInput {
  profile: string;
  approvalRate: number | null;
  item: RadarItem;
  examples: RadarExample[];
  image?: RadarImage;
  /** What the channel's own past posts show it publishes; absent until one is generated. */
  publicationProfile?: PublicationProfile | null;
  /** Which prompt to build; the baseline when absent. */
  promptVersion?: RadarPromptVersion;
  /** Retrieval prompt only: the most similar past publications, possibly none. */
  similarPublications?: RadarSimilarPublication[] | null;
  /** Approved-posts prompt only: the most similar posts the editor already approved. */
  similarApproved?: RadarSimilarApproved[] | null;
  /** Media prompt only: what the post's first image shows, in place of the image. */
  media?: RadarMediaContext | null;
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
  /** Only from the retrieval prompt, and only when it was shown past publications. */
  historicalAssessment: HistoricalAssessment | null;
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

/** Check a model's JSON text against `schema`; a mismatch is a RadarError. */
export function parseStructured<T>(schema: z.ZodType<T>, text: string, usage: TokenUsage): T {
  try {
    return schema.parse(JSON.parse(text));
  } catch (error) {
    throw new RadarError(`answer did not match the schema: ${(error as Error).message}`, usage);
  }
}

/** Check the model's JSON text against the schema and turn it into a prediction. */
export function toPrediction(text: string, usage: TokenUsage): RadarPrediction {
  const output = parseStructured(anyRadarOutputSchema, text, usage);
  const context = output.historical_context;

  return {
    // No provider enforces numeric ranges, so they are enforced here.
    score: clampPercent(output.score),
    predictedDecision: output.predicted_decision,
    topicFit: clampPercent(output.topic_fit),
    editorialFit: clampPercent(output.editorial_fit),
    importance: clampPercent(output.importance),
    reason: truncateToLength(output.reason.trim(), 500),
    predictedRejectionReason:
      output.predicted_decision === 'reject' ? output.predicted_rejection_reason : null,
    historicalAssessment: context
      ? {
          relevant: context.relevant,
          possiblyAlreadyCovered: context.possibly_already_covered,
          explanation: truncateToLength(context.explanation.trim(), 500),
        }
      : null,
    ...usage,
  };
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}
