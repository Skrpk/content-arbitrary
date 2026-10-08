import type { Database } from '@/lib/db';
import type { HistoryRetrievalRecord, HistoryRetrievalStatus } from '@/db/schema';
import { describeError } from '@/lib/errors';
import { scrub, type Logger } from '@/lib/logger';
import type { EmbeddingProvider } from '@/lib/history/embeddings/provider';
import {
  countSearchableApproved,
  countSearchableHistory,
  findCandidateEmbedding,
  findSimilarApprovedPosts,
  findSimilarHistoricalItems,
  upsertCandidateEmbedding,
  type ApprovedMatch,
  type HistoricalMatch,
} from '@/lib/history/embeddings/repository';
import { buildCandidateEmbeddingText, embeddingFingerprint } from '@/lib/history/embeddings/text';
import { loadUnderstandings } from '@/lib/media/repository';
import type { ImageUnderstanding, MediaUnderstandingConfig } from '@/lib/media/understanding';

/**
 * The past publications of a workspace most similar to a new post — and, when
 * asked, the most similar posts its editor already approved — for Shadow
 * Radar to read as context. One vector of the post serves both searches.
 *
 * Optional context, never a dependency: no text, nothing to search, no
 * embeddings configured, an API or database error — each ends in a result
 * with no matches and a status saying why, never in an exception, and the
 * post is scored as it would have been without it.
 */

/** How many similar publications Radar is shown: a few concrete examples, not a reading list. */
export const HISTORY_RETRIEVAL_LIMIT = 5;
/** How many similar approved posts, likewise. */
export const APPROVED_RETRIEVAL_LIMIT = 5;

const RETRIEVAL_TIMEOUT_MS = 10_000;

export interface HistoryRetrieval {
  /** How the search of publication history went. */
  status: HistoryRetrievalStatus;
  embeddingModel: string | null;
  matches: HistoricalMatch[];
  /** Only when approved posts were searched too, with their own status. */
  approved?: { status: HistoryRetrievalStatus; matches: ApprovedMatch[] };
  /** Spent embedding the post now; zero when its vector was already stored. */
  inputTokens: number;
  error?: string;
}

interface RetrievalInput {
  db: Database;
  workspaceId: number;
  processedPostId: number;
  candidateText: string | null;
  /** What the post's first image shows, embedded with its text when understood. */
  candidateImage?: ImageUnderstanding | null;
  /**
   * When set, each match comes with what its own first image shows
   * (`imageSummary`), for a prompt that reads image descriptions.
   */
  mediaConfig?: MediaUnderstandingConfig | null;
  /**
   * When the post arrived. Nothing published at or after it, and nothing the
   * editor approved at or after it, is searched.
   */
  before: Date;
  /** Search the posts the editor already approved as well. */
  includeApproved?: boolean;
  limit?: number;
}

export async function retrieveSimilarPublications(
  input: RetrievalInput & { embeddings: EmbeddingProvider | null; timeoutMs?: number; logger?: Logger },
): Promise<HistoryRetrieval> {
  const model = input.embeddings?.model ?? null;
  const text = buildCandidateEmbeddingText(input.candidateText, input.candidateImage);
  if (text === null) return none(input, model, 'no_text');
  if (!input.embeddings) return none(input, model, 'unavailable');
  const embeddings = input.embeddings;

  try {
    return await search(input, embeddings.model, text, async (fingerprint) => {
      const result = await embeddings.embed([text], { timeoutMs: input.timeoutMs ?? RETRIEVAL_TIMEOUT_MS });
      const vector = result.vectors[0]!;
      await upsertCandidateEmbedding(input.db, {
        processedPostId: input.processedPostId,
        model: embeddings.model,
        contentFingerprint: fingerprint,
        embedding: vector,
        inputTokens: result.inputTokens,
      });
      return { vector, inputTokens: result.inputTokens };
    }).then((retrieval) => {
      input.logger?.info('radar.history_retrieved', {
        processedPostId: input.processedPostId,
        matches: retrieval.matches.length,
        topSimilarity: retrieval.matches[0]?.similarity ?? null,
        approvedMatches: retrieval.approved?.matches.length,
        topApprovedSimilarity: retrieval.approved?.matches[0]?.similarity,
        // Not `inputTokens`: the logger redacts any key named *token*.
        usage: { input: retrieval.inputTokens },
      });
      return retrieval;
    });
  } catch (error) {
    input.logger?.warn('radar.history_retrieval_failed', {
      processedPostId: input.processedPostId,
      error: describeError(error),
    });
    return none(input, model, 'failed', scrub(describeError(error)).slice(0, 300));
  }
}

/**
 * The same search again, from the post's stored vector and without calling
 * the API: what a backfill's requests were built from, read back when their
 * results are recorded. A post with no stored vector had no search that
 * found anything — for want of text or of anything to search, or because it
 * failed.
 */
export async function replaySimilarPublications(input: RetrievalInput & { model: string }): Promise<HistoryRetrieval> {
  const text = buildCandidateEmbeddingText(input.candidateText, input.candidateImage);
  if (text === null) return none(input, input.model, 'no_text');
  return search(input, input.model, text, async () => null);
}

/**
 * Count what there is to search, find or make the post's vector only if there
 * is anything, then search. `embed` makes a missing vector, or returns null.
 */
async function search(
  input: RetrievalInput,
  model: string,
  text: string,
  embed: (fingerprint: string) => Promise<{ vector: number[]; inputTokens: number } | null>,
): Promise<HistoryRetrieval> {
  const history = { workspaceId: input.workspaceId, model, before: input.before };
  const approved = { ...history, excludePostId: input.processedPostId };

  const historyCount = await countSearchableHistory(input.db, history);
  const approvedCount = input.includeApproved ? await countSearchableApproved(input.db, approved) : 0;
  // Checked first, so a workspace with nothing to search costs no embedding call.
  if (historyCount === 0 && approvedCount === 0) return none(input, model, 'no_history');

  const fingerprint = embeddingFingerprint(text);
  let vector = await findCandidateEmbedding(input.db, {
    processedPostId: input.processedPostId,
    model,
    contentFingerprint: fingerprint,
  });
  let inputTokens = 0;
  if (!vector) {
    const made = await embed(fingerprint);
    if (!made) {
      const failed: HistoryRetrievalStatus = 'failed';
      return {
        status: historyCount > 0 ? failed : 'no_history',
        embeddingModel: model,
        matches: [],
        ...(input.includeApproved ? { approved: { status: approvedCount > 0 ? failed : 'no_history', matches: [] } } : {}),
        inputTokens: 0,
      };
    }
    vector = made.vector;
    inputTokens = made.inputTokens;
  }

  const matches =
    historyCount > 0
      ? await findSimilarHistoricalItems(input.db, {
          ...history,
          embedding: vector,
          limit: input.limit ?? HISTORY_RETRIEVAL_LIMIT,
        })
      : [];
  const approvedMatches =
    approvedCount > 0
      ? await findSimilarApprovedPosts(input.db, {
          ...approved,
          embedding: vector,
          limit: input.limit ?? APPROVED_RETRIEVAL_LIMIT,
        })
      : [];

  if (input.mediaConfig) await describeImages(input.db, input.mediaConfig, [...matches, ...approvedMatches]);

  return {
    status: matches.length > 0 ? 'ok' : 'no_history',
    embeddingModel: model,
    matches,
    ...(input.includeApproved
      ? { approved: { status: approvedMatches.length > 0 ? 'ok' : 'no_history', matches: approvedMatches } }
      : {}),
    inputTokens,
  };
}

/** Attach what each match's first image shows, from stored understandings: one query, no vision call. */
async function describeImages(
  db: Database,
  config: MediaUnderstandingConfig,
  matches: { imageFingerprint: string | null; imageSummary?: string | null }[],
): Promise<void> {
  const understood = await loadUnderstandings(db, {
    fingerprints: matches.flatMap((match) => (match.imageFingerprint ? [match.imageFingerprint] : [])),
    config,
  });
  for (const match of matches) {
    match.imageSummary = match.imageFingerprint ? (understood.get(match.imageFingerprint)?.summary ?? null) : null;
  }
}

function none(
  input: Pick<RetrievalInput, 'includeApproved'>,
  model: string | null,
  status: HistoryRetrievalStatus,
  error?: string,
): HistoryRetrieval {
  return {
    status,
    embeddingModel: model,
    matches: [],
    ...(input.includeApproved ? { approved: { status, matches: [] } } : {}),
    inputTokens: 0,
    ...(error ? { error } : {}),
  };
}

/**
 * What a radar_evaluations row keeps of a search: ids and similarities, not
 * the texts — and the approved posts only for a prompt that was shown them.
 */
export function toRetrievalRecord(
  retrieval: HistoryRetrieval,
  options: { approved?: boolean } = {},
): HistoryRetrievalRecord {
  const ids = (matches: { id: number; similarity: number }[]) =>
    matches.map((match) => ({ id: match.id, similarity: Math.round(match.similarity * 10_000) / 10_000 }));
  return {
    status: retrieval.status,
    embeddingModel: retrieval.embeddingModel,
    matches: ids(retrieval.matches.map((match) => ({ id: match.itemId, similarity: match.similarity }))),
    ...(options.approved && retrieval.approved
      ? {
          approved: {
            status: retrieval.approved.status,
            matches: ids(
              retrieval.approved.matches.map((match) => ({ id: match.processedPostId, similarity: match.similarity })),
            ),
          },
        }
      : {}),
    ...(retrieval.error ? { error: retrieval.error } : {}),
  };
}
