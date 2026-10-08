import OpenAI, { toFile } from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
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

export const OPENAI_RADAR_MODEL = 'gpt-6-luna';

/**
 * Luna reasons before answering, and reasoning is billed as output. Scoring a
 * post against a profile and examples needs little of it; the default
 * (medium) would multiply the cost for no measured gain.
 */
const REASONING_EFFORT = 'low' as const;
/** Headroom for the reasoning as well as the answer, which both count here. */
const MAX_OUTPUT_TOKENS = 4000;

const textFormats = {
  baseline: zodTextFormat(radarOutputSchema, 'radar_prediction'),
  retrieval: zodTextFormat(radarRetrievalOutputSchema, 'radar_prediction'),
};

const ENDED_BATCH_STATUSES = new Set(['completed', 'failed', 'expired', 'cancelled']);

/**
 * The parts of a Responses API result Radar reads. Live results arrive through
 * the SDK, batch results as raw JSON from a file; both are checked against
 * this before use.
 */
const responseBodySchema = z.object({
  status: z.string().optional(),
  incomplete_details: z.object({ reason: z.string().optional() }).nullable().optional(),
  output: z
    .array(
      z.object({
        type: z.string(),
        content: z
          .array(
            z.object({
              type: z.string(),
              text: z.string().optional(),
              refusal: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .default([]),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).nullable().optional(),
});

const batchLineSchema = z.object({
  custom_id: z.string(),
  response: z.object({ status_code: z.number(), body: z.unknown() }).nullable().optional(),
  error: z
    .object({ code: z.string().nullable().optional(), message: z.string().nullable().optional() })
    .nullable()
    .optional(),
});

export function createOpenAiRadar(options: {
  apiKey?: string;
  client?: OpenAI;
  model?: string;
}): RadarProvider {
  const client = options.client ?? new OpenAI({ apiKey: options.apiKey });
  const model = options.model ?? OPENAI_RADAR_MODEL;

  const request = (input: RadarInput): OpenAI.Responses.ResponseCreateParamsNonStreaming => ({
    model,
    instructions: buildSystemPrompt(input.profile, input.approvalRate, input.publicationProfile, input.promptVersion),
    input: [
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
          toOpenAiPart,
        ),
      },
    ],
    text: { format: retrievalPrompt(input) ? textFormats.retrieval : textFormats.baseline },
    reasoning: { effort: REASONING_EFFORT },
    max_output_tokens: MAX_OUTPUT_TOKENS,
    // Nothing to come back to: do not keep the post on OpenAI's side.
    store: false,
  });

  return {
    name: 'openai',
    model,

    async score(input, { timeoutMs }) {
      const response = await client.responses.create(request(input), {
        timeout: timeoutMs,
        // One retry at most: live scoring runs inside the sync, on its clock.
        maxRetries: 1,
      });
      return parseResponseBody(response);
    },

    async complete(completion) {
      const response = await client.responses.create(
        {
          model,
          instructions: completion.instructions,
          input: [{ role: 'user', content: [{ type: 'input_text', text: completion.input }] }],
          text: { format: zodTextFormat(completion.schema, completion.schemaName) },
          reasoning: { effort: REASONING_EFFORT },
          max_output_tokens: completion.maxOutputTokens,
          store: false,
        },
        { timeout: completion.timeoutMs, maxRetries: 2 },
      );
      const { text, usage } = responseText(response);
      return { output: parseStructured(completion.schema, text, usage), usage };
    },

    batchEntry: (customId, input) => ({
      custom_id: customId,
      method: 'POST',
      url: '/v1/responses',
      body: request(input),
    }),

    async submitBatch(entries) {
      const jsonl = entries.map((entry) => JSON.stringify(entry)).join('\n');
      const file = await client.files.create({
        file: await toFile(Buffer.from(jsonl), 'radar-batch.jsonl'),
        purpose: 'batch',
      });
      const batch = await client.batches.create({
        input_file_id: file.id,
        endpoint: '/v1/responses',
        completion_window: '24h',
      });
      return batch.id;
    },

    async pollBatch(batchId) {
      const batch = await client.batches.retrieve(batchId);
      const counts = batch.request_counts;
      return {
        ended: ENDED_BATCH_STATUSES.has(batch.status),
        status: counts
          ? `${batch.status}: ${counts.completed} done, ${counts.failed} failed, of ${counts.total}`
          : batch.status,
      };
    },

    async *batchResults(batchId): AsyncIterable<RadarBatchResult> {
      const batch = await client.batches.retrieve(batchId);
      if (batch.status === 'failed') {
        const reasons = batch.errors?.data?.map((error) => error.message).join('; ');
        throw new Error(`OpenAI batch ${batchId} failed: ${reasons ?? 'no reason given'}`);
      }

      // Successes and failures come back in separate files. A request in
      // neither (an expired batch) is simply not recorded, so it is retried.
      for (const fileId of [batch.output_file_id, batch.error_file_id]) {
        if (!fileId) continue;
        const content = await (await client.files.content(fileId)).text();
        for (const line of content.split('\n')) {
          if (line.trim()) yield toBatchResult(line);
        }
      }
    },
  };
}

function toBatchResult(line: string): RadarBatchResult {
  const parsed = batchLineSchema.safeParse(JSON.parse(line));
  if (!parsed.success) {
    throw new Error(`unexpected OpenAI batch output line: ${parsed.error.message}`);
  }
  const { custom_id: customId, response, error } = parsed.data;

  if (response?.status_code === 200) {
    try {
      return { customId, ok: true, prediction: parseResponseBody(response.body) };
    } catch (failure) {
      return {
        customId,
        ok: false,
        error: (failure as Error).message,
        usage: failure instanceof RadarError ? failure.usage : undefined,
      };
    }
  }

  const bodyError = (response?.body as { error?: { message?: string } } | undefined)?.error?.message;
  return {
    customId,
    ok: false,
    error: `batch request failed${response ? ` (HTTP ${response.status_code})` : ''}: ${
      bodyError ?? error?.message ?? error?.code ?? 'no reason given'
    }`,
  };
}

function parseResponseBody(body: unknown): RadarPrediction {
  const { text, usage } = responseText(body);
  return toPrediction(text, usage);
}

/** The answer's text, once the response is known to be a finished, unrefused one. */
function responseText(body: unknown): { text: string; usage: TokenUsage } {
  const parsed = responseBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new RadarError(`unexpected response shape: ${parsed.error.message}`);
  }
  const response = parsed.data;
  const usage = {
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };

  // Cut short (out of tokens) or otherwise unfinished: not a prediction.
  if (response.status !== 'completed') {
    const reason = response.incomplete_details?.reason;
    throw new RadarError(
      `no usable answer (status: ${response.status ?? 'unknown'}${reason ? `, ${reason}` : ''})`,
      usage,
    );
  }

  const parts = response.output
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? []);

  const refusal = parts.find((part) => part.type === 'refusal');
  if (refusal) throw new RadarError(`refused: ${refusal.refusal ?? ''}`, usage);

  const text = parts
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text ?? '')
    .join('');
  return { text, usage };
}

function toOpenAiPart(part: RadarPart): OpenAI.Responses.ResponseInputContent {
  if (part.type === 'text') return { type: 'input_text', text: part.text };
  const { image } = part;
  return {
    type: 'input_image',
    image_url: image.kind === 'url' ? image.url : `data:${image.mediaType};base64,${image.data}`,
    // A low-resolution look: enough to tell what the picture is, at a
    // fraction of the tokens.
    detail: 'low',
  };
}

function retrievalPrompt(input: RadarInput): boolean {
  return input.promptVersion !== undefined && usesHistoryRetrieval(input.promptVersion);
}
