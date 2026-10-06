import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { REJECTION_REASONS, type RejectionReason } from '@/db/schema';
import {
  buildSystemPrompt,
  buildUserContent,
  RADAR_MODEL,
  type RadarExample,
  type RadarImage,
  type RadarItem,
} from '@/lib/radar/prompt';

/**
 * One Radar call: the post in, a structured prediction out.
 *
 * The answer is constrained to this schema by the API and validated again on
 * our side. The fields are in the order the model fills them in — the reason
 * first, the score last — so the score follows from what it has just said.
 */
const radarOutputSchema = z.object({
  reason: z.string(),
  topic_fit: z.number().int(),
  editorial_fit: z.number().int(),
  importance: z.number().int(),
  predicted_rejection_reason: z.enum(REJECTION_REASONS).nullable(),
  predicted_decision: z.enum(['approve', 'reject']),
  score: z.number().int(),
});

export interface RadarPrediction {
  score: number;
  predictedDecision: 'approve' | 'reject';
  topicFit: number;
  editorialFit: number;
  importance: number;
  reason: string;
  predictedRejectionReason: RejectionReason | null;
  inputTokens: number;
  outputTokens: number;
}

export class RadarError extends Error {
  constructor(
    message: string,
    readonly usage?: { inputTokens: number; outputTokens: number },
  ) {
    super(message);
    this.name = 'RadarError';
  }
}

export async function scorePost(
  client: Anthropic,
  input: {
    profile: string;
    approvalRate: number | null;
    item: RadarItem;
    examples: RadarExample[];
    image?: RadarImage;
  },
  options: { timeoutMs: number },
): Promise<RadarPrediction> {
  const format = zodOutputFormat(radarOutputSchema);
  // `create`, not `parse`: parsing is done below, after the stop reason is
  // checked, so a refusal is reported as one — with the tokens it cost.
  const response = await client.messages.create(
    {
      model: RADAR_MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(input.profile, input.approvalRate),
      messages: [
        { role: 'user', content: buildUserContent(input.item, input.examples, input.image) },
      ],
      output_config: { format },
    },
    // One retry at most: this runs inside the sync, which has its own clock.
    { timeout: options.timeoutMs, maxRetries: 1 },
  );

  const usage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };

  // A refused or cut-off answer need not match the schema; it is a failure,
  // not a prediction.
  if (response.stop_reason !== 'end_turn') {
    throw new RadarError(`no usable answer (stop_reason: ${response.stop_reason})`, usage);
  }

  const text = response.content.find((block) => block.type === 'text')?.text ?? '';
  let output: z.infer<typeof radarOutputSchema>;
  try {
    output = format.parse(text);
  } catch (error) {
    throw new RadarError(`answer did not match the schema: ${(error as Error).message}`, usage);
  }

  return {
    // The API cannot enforce numeric ranges, so they are enforced here.
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
