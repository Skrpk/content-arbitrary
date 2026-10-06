import type { Database } from '@/lib/db';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import {
  EMBEDDING_REQUEST_MAX_CHARS,
  EMBEDDING_REQUEST_MAX_INPUTS,
  type EmbeddingProvider,
} from '@/lib/history/embeddings/provider';
import {
  deleteHistoryEmbeddings,
  loadHistoryForEmbedding,
  upsertHistoryEmbeddings,
} from '@/lib/history/embeddings/repository';
import { buildHistoryEmbeddingText, embeddingFingerprint } from '@/lib/history/embeddings/text';
import { packByBudget } from '@/lib/history/profile/prompt';

/**
 * Embed a workspace's publication history: every item with text that has no
 * vector for the current model, or whose vector was made from different text.
 *
 * Incremental by construction — an unchanged item's fingerprint matches its
 * stored vector and costs nothing — so it is safe to run after every import.
 * Items without text (photo- or video-only) are left as they are, without a
 * vector; one that has lost its text since loses its stale vector.
 */

export interface HistoryEmbeddingSummary {
  model: string;
  items: number;
  /** Items with text to embed. */
  eligible: number;
  alreadyEmbedded: number;
  /** Embedded this run, for the first time. */
  embedded: number;
  /** Embedded again because their text changed. */
  reembedded: number;
  skippedNoText: number;
  /** Vectors dropped because their item no longer has text. */
  removedStale: number;
  failed: number;
  requests: number;
  inputTokens: number;
}

export async function embedPublicationHistory(input: {
  db: Database;
  embeddings: EmbeddingProvider;
  workspaceId: number;
  /** Count what would be embedded, without calling the API or writing. */
  dryRun?: boolean;
  logger?: Logger;
  signal?: AbortSignal;
}): Promise<HistoryEmbeddingSummary> {
  const { db, embeddings, workspaceId } = input;
  const model = embeddings.model;
  const items = await loadHistoryForEmbedding(db, { workspaceId, model });

  const summary: HistoryEmbeddingSummary = {
    model,
    items: items.length,
    eligible: 0,
    alreadyEmbedded: 0,
    embedded: 0,
    reembedded: 0,
    skippedNoText: 0,
    removedStale: 0,
    failed: 0,
    requests: 0,
    inputTokens: 0,
  };

  const pending: { itemId: number; text: string; fingerprint: string; changed: boolean }[] = [];
  const stale: number[] = [];

  for (const item of items) {
    const text = buildHistoryEmbeddingText(item);
    if (text === null) {
      summary.skippedNoText += 1;
      if (item.storedFingerprint !== null) stale.push(item.id);
      continue;
    }
    summary.eligible += 1;
    const fingerprint = embeddingFingerprint(text);
    if (item.storedFingerprint === fingerprint) {
      summary.alreadyEmbedded += 1;
      continue;
    }
    pending.push({ itemId: item.id, text, fingerprint, changed: item.storedFingerprint !== null });
  }

  if (input.dryRun) {
    summary.removedStale = stale.length;
    summary.embedded = pending.filter((item) => !item.changed).length;
    summary.reembedded = pending.length - summary.embedded;
    return summary;
  }

  await deleteHistoryEmbeddings(db, { itemIds: stale, model });
  summary.removedStale = stale.length;

  const requests = packByBudget(pending, (item) => item.text.length, EMBEDDING_REQUEST_MAX_CHARS).flatMap(
    (group) => chunk(group, EMBEDDING_REQUEST_MAX_INPUTS),
  );

  for (const request of requests) {
    input.signal?.throwIfAborted();
    try {
      const result = await embeddings.embed(
        request.map((item) => item.text),
        { signal: input.signal },
      );
      summary.requests += 1;
      summary.inputTokens += result.inputTokens;
      await upsertHistoryEmbeddings(
        db,
        request.map((item, index) => ({
          itemId: item.itemId,
          model,
          contentFingerprint: item.fingerprint,
          embedding: result.vectors[index]!,
        })),
      );
      for (const item of request) {
        if (item.changed) summary.reembedded += 1;
        else summary.embedded += 1;
      }
    } catch (error) {
      if (input.signal?.aborted) throw error;
      // One failed request leaves its items for the next run; the rest go on.
      summary.failed += request.length;
      input.logger?.warn('history.embed_request_failed', {
        workspaceId,
        items: request.length,
        error: describeError(error),
      });
    }
  }

  // Usage under a key the logger does not take for a secret: it redacts anything named *token*.
  const { inputTokens, ...counts } = summary;
  input.logger?.info('history.embedded', { ...counts, workspaceId, usage: { input: inputTokens } });
  return summary;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}
