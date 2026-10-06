import type { Database } from '@/lib/db';
import type { HistoryRetrievalRecord, HistoryRetrievalStatus } from '@/db/schema';
import { describeError } from '@/lib/errors';
import { scrub, type Logger } from '@/lib/logger';
import type { EmbeddingProvider } from '@/lib/history/embeddings/provider';
import {
  countSearchableHistory,
  findCandidateEmbedding,
  findSimilarHistoricalItems,
  upsertCandidateEmbedding,
  type HistoricalMatch,
} from '@/lib/history/embeddings/repository';
import { buildCandidateEmbeddingText, embeddingFingerprint } from '@/lib/history/embeddings/text';

/**
 * The past publications of a workspace most similar to a new post, for
 * Shadow Radar to read as context.
 *
 * Optional context, never a dependency: no text, no history, no embeddings
 * configured, an API or database error — each ends in a result with no
 * matches and a status saying why, never in an exception, and the post is
 * scored as it would have been without it.
 */

/** How many similar publications Radar is shown: a few concrete examples, not a reading list. */
export const HISTORY_RETRIEVAL_LIMIT = 5;

const RETRIEVAL_TIMEOUT_MS = 10_000;

export interface HistoryRetrieval {
  status: HistoryRetrievalStatus;
  embeddingModel: string | null;
  matches: HistoricalMatch[];
  /** Spent embedding the post now; zero when its vector was already stored. */
  inputTokens: number;
  error?: string;
}

export async function retrieveSimilarPublications(input: {
  db: Database;
  embeddings: EmbeddingProvider | null;
  workspaceId: number;
  processedPostId: number;
  candidateText: string | null;
  /** When the post arrived. Nothing published at or after it is searched. */
  before: Date;
  limit?: number;
  timeoutMs?: number;
  logger?: Logger;
}): Promise<HistoryRetrieval> {
  const model = input.embeddings?.model ?? null;
  const none = (status: HistoryRetrievalStatus, error?: string): HistoryRetrieval => ({
    status,
    embeddingModel: model,
    matches: [],
    inputTokens: 0,
    ...(error ? { error } : {}),
  });

  const text = buildCandidateEmbeddingText(input.candidateText);
  if (text === null) return none('no_text');
  if (!input.embeddings) return none('unavailable');
  const embeddings = input.embeddings;

  try {
    const scope = { workspaceId: input.workspaceId, model: embeddings.model, before: input.before };
    // Checked first, so a workspace without history costs no embedding call.
    if ((await countSearchableHistory(input.db, scope)) === 0) return none('no_history');

    const fingerprint = embeddingFingerprint(text);
    let vector = await findCandidateEmbedding(input.db, {
      processedPostId: input.processedPostId,
      model: embeddings.model,
      contentFingerprint: fingerprint,
    });
    let inputTokens = 0;
    if (!vector) {
      const result = await embeddings.embed([text], { timeoutMs: input.timeoutMs ?? RETRIEVAL_TIMEOUT_MS });
      vector = result.vectors[0]!;
      inputTokens = result.inputTokens;
      await upsertCandidateEmbedding(input.db, {
        processedPostId: input.processedPostId,
        model: embeddings.model,
        contentFingerprint: fingerprint,
        embedding: vector,
        inputTokens,
      });
    }

    const matches = await findSimilarHistoricalItems(input.db, {
      ...scope,
      embedding: vector,
      limit: input.limit ?? HISTORY_RETRIEVAL_LIMIT,
    });
    input.logger?.info('radar.history_retrieved', {
      processedPostId: input.processedPostId,
      matches: matches.length,
      topSimilarity: matches[0]?.similarity ?? null,
      // Not `inputTokens`: the logger redacts any key named *token*.
      usage: { input: inputTokens },
    });
    return { status: matches.length > 0 ? 'ok' : 'no_history', embeddingModel: model, matches, inputTokens };
  } catch (error) {
    input.logger?.warn('radar.history_retrieval_failed', {
      processedPostId: input.processedPostId,
      error: describeError(error),
    });
    return none('failed', scrub(describeError(error)).slice(0, 300));
  }
}

/**
 * The same search again, from the post's stored vector and without calling
 * the API: what a backfill's requests were built from, read back when their
 * results are recorded. A post with no stored vector had no search that
 * found anything — for want of text or of history, or because it failed.
 */
export async function replaySimilarPublications(input: {
  db: Database;
  model: string;
  workspaceId: number;
  processedPostId: number;
  candidateText: string | null;
  before: Date;
  limit?: number;
}): Promise<HistoryRetrieval> {
  const none = (status: HistoryRetrievalStatus): HistoryRetrieval => ({
    status,
    embeddingModel: input.model,
    matches: [],
    inputTokens: 0,
  });

  const text = buildCandidateEmbeddingText(input.candidateText);
  if (text === null) return none('no_text');
  const scope = { workspaceId: input.workspaceId, model: input.model, before: input.before };
  if ((await countSearchableHistory(input.db, scope)) === 0) return none('no_history');

  const vector = await findCandidateEmbedding(input.db, {
    processedPostId: input.processedPostId,
    model: input.model,
    contentFingerprint: embeddingFingerprint(text),
  });
  if (!vector) return none('failed');

  const matches = await findSimilarHistoricalItems(input.db, {
    ...scope,
    embedding: vector,
    limit: input.limit ?? HISTORY_RETRIEVAL_LIMIT,
  });
  return { status: matches.length > 0 ? 'ok' : 'no_history', embeddingModel: input.model, matches, inputTokens: 0 };
}

/** What a radar_evaluations row keeps of a search: ids and similarities, not the texts. */
export function toRetrievalRecord(retrieval: HistoryRetrieval): HistoryRetrievalRecord {
  return {
    status: retrieval.status,
    embeddingModel: retrieval.embeddingModel,
    matches: retrieval.matches.map((match) => ({
      id: match.itemId,
      similarity: Math.round(match.similarity * 10_000) / 10_000,
    })),
    ...(retrieval.error ? { error: retrieval.error } : {}),
  };
}
