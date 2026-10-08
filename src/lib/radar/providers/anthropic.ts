import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  parseStructured,
  RadarError,
  radarOutputSchema,
  radarRetrievalOutputSchema,
  toPrediction,
  type RadarInput,
  type RadarPrediction,
  type TokenUsage,
} from '@/lib/radar/output';
import { buildSystemPrompt, buildUserContent, usesHistoryRetrieval, type RadarPart } from '@/lib/radar/prompt';
import type { RadarBatchResult, RadarProvider } from '@/lib/radar/providers/types';

export const ANTHROPIC_RADAR_MODEL = 'claude-haiku-4-5';

// Sent to constrain the answer; the answer is parsed by toPrediction, after
// the stop reason is checked, so a refusal is reported as one.
const outputFormats = {
  baseline: zodOutputFormat(radarOutputSchema),
  retrieval: zodOutputFormat(radarRetrievalOutputSchema),
};

export function createAnthropicRadar(options: {
  apiKey?: string;
  client?: Anthropic;
  model?: string;
}): RadarProvider {
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey });
  const model = options.model ?? ANTHROPIC_RADAR_MODEL;

  const request = (input: RadarInput): Anthropic.MessageCreateParamsNonStreaming => ({
    model,
    max_tokens: 1024,
    system: buildSystemPrompt(input.profile, input.approvalRate, input.publicationProfile, input.promptVersion),
    messages: [
      {
        role: 'user',
        content: buildUserContent(
          input.item,
          input.examples,
          input.image,
          input.similarPublications,
          input.similarApproved,
          input.media,
        ).map(
          toAnthropicBlock,
        ),
      },
    ],
    output_config: { format: retrievalPrompt(input) ? outputFormats.retrieval : outputFormats.baseline },
  });

  return {
    name: 'anthropic',
    model,

    async score(input, { timeoutMs }) {
      const message = await client.messages.create(request(input), {
        timeout: timeoutMs,
        // One retry at most: live scoring runs inside the sync, on its clock.
        maxRetries: 1,
      });
      return parseMessage(message);
    },

    async complete(completion) {
      const message = await client.messages.create(
        {
          model,
          max_tokens: completion.maxOutputTokens,
          system: completion.instructions,
          messages: [{ role: 'user', content: completion.input }],
          output_config: { format: zodOutputFormat(completion.schema) },
        },
        { timeout: completion.timeoutMs, maxRetries: 2 },
      );
      const { text, usage } = messageText(message);
      return { output: parseStructured(completion.schema, text, usage), usage };
    },

    batchEntry: (customId, input) => ({ custom_id: customId, params: request(input) }),

    async submitBatch(entries) {
      const batch = await client.messages.batches.create({
        requests: entries as Anthropic.Messages.BatchCreateParams.Request[],
      });
      return batch.id;
    },

    async pollBatch(batchId) {
      const batch = await client.messages.batches.retrieve(batchId);
      const counts = batch.request_counts;
      return {
        ended: batch.processing_status === 'ended',
        status:
          `${batch.processing_status}: ${counts.succeeded} done, ${counts.processing} processing, ` +
          `${counts.errored} errored`,
      };
    },

    async *batchResults(batchId): AsyncIterable<RadarBatchResult> {
      for await (const entry of await client.messages.batches.results(batchId)) {
        const result = entry.result;
        if (result.type === 'succeeded') {
          try {
            yield { customId: entry.custom_id, ok: true, prediction: parseMessage(result.message) };
          } catch (error) {
            yield {
              customId: entry.custom_id,
              ok: false,
              error: (error as Error).message,
              usage: error instanceof RadarError ? error.usage : undefined,
            };
          }
          continue;
        }
        // errored, expired or canceled: not billed, and retried by the next submit.
        yield {
          customId: entry.custom_id,
          ok: false,
          error:
            result.type === 'errored'
              ? `batch request ${result.error.error.type}: ${result.error.error.message}`
              : `batch request ${result.type}`,
        };
      }
    },
  };
}

function parseMessage(message: Anthropic.Message): RadarPrediction {
  const { text, usage } = messageText(message);
  return toPrediction(text, usage);
}

/** The answer's text, once the message is known to have finished normally. */
function messageText(message: Anthropic.Message): { text: string; usage: TokenUsage } {
  const usage = {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };

  // A refused or cut-off answer need not match the schema; it is a failure,
  // not a prediction.
  if (message.stop_reason !== 'end_turn') {
    throw new RadarError(`no usable answer (stop_reason: ${message.stop_reason})`, usage);
  }

  const text = message.content.find((block) => block.type === 'text')?.text ?? '';
  return { text, usage };
}

function toAnthropicBlock(part: RadarPart): Anthropic.ContentBlockParam {
  if (part.type === 'text') return { type: 'text', text: part.text };
  const { image } = part;
  return {
    type: 'image',
    source:
      image.kind === 'url'
        ? { type: 'url', url: image.url }
        : { type: 'base64', media_type: image.mediaType, data: image.data },
  };
}

function retrievalPrompt(input: RadarInput): boolean {
  return input.promptVersion !== undefined && usesHistoryRetrieval(input.promptVersion);
}
