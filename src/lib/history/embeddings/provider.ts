import OpenAI from 'openai';
import { z } from 'zod';
import type { Env } from '@/lib/env';

/**
 * Text embeddings, from OpenAI's embeddings API. The model comes from
 * HISTORY_EMBEDDING_MODEL; everything else sees only `EmbeddingProvider`.
 */

export interface EmbeddingProvider {
  /** Stored with every vector; vectors of different models are never compared. */
  readonly model: string;
  /** One vector per text, in the same order. Throws on any failure. */
  embed(texts: string[], options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<EmbeddingResult>;
}

export interface EmbeddingResult {
  vectors: number[][];
  inputTokens: number;
}

/**
 * List prices, USD per million input tokens (OpenAI's model pages). A model not
 * listed is reported without a cost.
 */
const PRICE_PER_MILLION: Record<string, number> = {
  'text-embedding-3-small': 0.02,
  'text-embedding-3-large': 0.13,
};

export function embeddingCostUsd(model: string, inputTokens: number): number | null {
  const price = PRICE_PER_MILLION[model];
  return price === undefined ? null : (inputTokens * price) / 1_000_000;
}

/**
 * The API takes up to 2,048 inputs and 300,000 tokens per request. Texts are
 * at most EMBEDDING_TEXT_MAX characters, so these limits keep a request under
 * both even at a token per character.
 */
export const EMBEDDING_REQUEST_MAX_INPUTS = 128;
export const EMBEDDING_REQUEST_MAX_CHARS = 200_000;

const responseSchema = z.object({
  data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number()).min(1) })),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative() }),
});

export function createOpenAiEmbeddings(options: {
  apiKey?: string;
  client?: OpenAI;
  model: string;
}): EmbeddingProvider {
  const client = options.client ?? new OpenAI({ apiKey: options.apiKey });
  const { model } = options;

  return {
    model,
    async embed(texts, { timeoutMs = 30_000, signal } = {}) {
      if (texts.length === 0) return { vectors: [], inputTokens: 0 };
      const response = await client.embeddings.create(
        { model, input: texts, encoding_format: 'float' },
        { timeout: timeoutMs, maxRetries: 2, signal },
      );
      return checkResponse(response, texts.length);
    },
  };
}

/** The vectors in input order, once the response is known to hold exactly one sound vector per text. */
export function checkResponse(body: unknown, expected: number): EmbeddingResult {
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) throw new Error(`unexpected embeddings response: ${parsed.error.message}`);

  const vectors: number[][] = new Array(expected);
  for (const item of parsed.data.data) {
    if (item.index >= expected || vectors[item.index]) {
      throw new Error(`unexpected embeddings response: index ${item.index} for ${expected} inputs`);
    }
    if (!item.embedding.every(Number.isFinite)) {
      throw new Error('unexpected embeddings response: a vector holds a non-finite number');
    }
    vectors[item.index] = item.embedding;
  }

  const dimensions = vectors[0]?.length;
  for (let index = 0; index < expected; index += 1) {
    if (!vectors[index]) throw new Error(`unexpected embeddings response: no vector for input ${index}`);
    if (vectors[index]!.length !== dimensions) {
      throw new Error('unexpected embeddings response: vectors of different lengths');
    }
  }
  return { vectors, inputTokens: parsed.data.usage.prompt_tokens };
}

/** The configured embeddings, or null without OPENAI_API_KEY — which leaves retrieval off. */
export function createEmbeddingProvider(
  env: Pick<Env, 'OPENAI_API_KEY' | 'HISTORY_EMBEDDING_MODEL'>,
): EmbeddingProvider | null {
  return env.OPENAI_API_KEY
    ? createOpenAiEmbeddings({ apiKey: env.OPENAI_API_KEY, model: env.HISTORY_EMBEDDING_MODEL })
    : null;
}
