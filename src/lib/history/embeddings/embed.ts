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
  loadProcessedPostsForEmbedding,
  upsertCandidateEmbeddings,
  upsertHistoryEmbeddings,
} from '@/lib/history/embeddings/repository';
import {
  buildCandidateEmbeddingText,
  buildHistoryEmbeddingText,
  embeddingFingerprint,
} from '@/lib/history/embeddings/text';
import { packByBudget } from '@/lib/history/profile/prompt';
import { loadUnderstandings, understandingOf } from '@/lib/media/repository';
import type { ImageUnderstanding, MediaUnderstandingConfig } from '@/lib/media/understanding';

/**
 * Embed what similar-publication search compares against: a workspace's
 * publication history, and the posts that went through its review — every
 * item with text that has no vector for the current model, or whose vector
 * was made from different text.
 *
 * What is embedded is the item's text and, once its first image has been
 * understood (`history:understand-images`, or live for a new post), what the
 * image shows — see buildSemanticContentRepresentation. Understanding an
 * image changes that item's text, and so its fingerprint, and so it alone is
 * embedded again; an image-only item, which had nothing to embed, gets its
 * first vector.
 *
 * Incremental by construction — an unchanged item's fingerprint matches its
 * stored vector and costs nothing — so it is safe to run after every import.
 * Items with neither text nor an understood image are left without a vector;
 * one that has lost both since loses its stale vector.
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

interface EmbedOptions {
  db: Database;
  embeddings: EmbeddingProvider;
  workspaceId: number;
  /** Count what would be embedded, without calling the API or writing. */
  dryRun?: boolean;
  /** Whose image understandings to embed with the text; without it, text alone. */
  mediaConfig?: MediaUnderstandingConfig | null;
  logger?: Logger;
  signal?: AbortSignal;
}

interface Pending {
  id: number;
  text: string;
  fingerprint: string;
  changed: boolean;
}

export async function embedPublicationHistory(input: EmbedOptions): Promise<HistoryEmbeddingSummary> {
  const { db, embeddings, workspaceId } = input;
  const model = embeddings.model;
  const items = await loadHistoryForEmbedding(db, { workspaceId, model });
  const images = await imagesOf(input, items);
  const { summary, pending, stale } = plan(model, items, (item) =>
    buildHistoryEmbeddingText(item, imageOf(images, item.imageFingerprint)),
  );

  if (input.dryRun) return dryRun(summary, pending, stale);

  await deleteHistoryEmbeddings(db, { itemIds: stale, model });
  summary.removedStale = stale.length;

  await embedPending(input, summary, pending, (request, vectors) =>
    upsertHistoryEmbeddings(
      db,
      request.map((item, index) => ({
        itemId: item.id,
        model,
        contentFingerprint: item.fingerprint,
        embedding: vectors[index]!,
      })),
    ),
  );

  log(input, 'history.embedded', summary);
  return summary;
}

/**
 * The workspace's processed posts — the candidates its reviewer has seen —
 * so that once one is approved, later candidates can be compared with it. A
 * post scored live is embedded then; this covers the ones that never were.
 */
export async function embedProcessedPosts(input: EmbedOptions): Promise<HistoryEmbeddingSummary> {
  const { db, embeddings, workspaceId } = input;
  const model = embeddings.model;
  const posts = await loadProcessedPostsForEmbedding(db, { workspaceId, model });
  const images = await imagesOf(input, posts);
  const { summary, pending, stale } = plan(model, posts, (post) =>
    buildCandidateEmbeddingText(post.text, imageOf(images, post.imageFingerprint)),
  );

  // A post's text is never changed, so a post without text has no vector to drop.
  if (input.dryRun) return dryRun(summary, pending, stale);

  await embedPending(input, summary, pending, (request, vectors) =>
    upsertCandidateEmbeddings(
      db,
      request.map((post, index) => ({
        processedPostId: post.id,
        model,
        contentFingerprint: post.fingerprint,
        embedding: vectors[index]!,
        inputTokens: null,
      })),
    ),
  );

  log(input, 'history.posts_embedded', summary);
  return summary;
}

/** The current understandings of these items' images, by fingerprint; none without a config. */
async function imagesOf(input: EmbedOptions, items: { imageFingerprint: string | null }[]) {
  if (!input.mediaConfig) return new Map<string, ImageUnderstanding>();
  const rows = await loadUnderstandings(input.db, {
    fingerprints: items.flatMap((item) => (item.imageFingerprint ? [item.imageFingerprint] : [])),
    config: input.mediaConfig,
  });
  return new Map([...rows].flatMap(([fingerprint, row]) => {
    const understanding = understandingOf(row);
    return understanding ? [[fingerprint, understanding] as const] : [];
  }));
}

function imageOf(images: Map<string, ImageUnderstanding>, fingerprint: string | null): ImageUnderstanding | null {
  return fingerprint ? (images.get(fingerprint) ?? null) : null;
}

function plan<T extends { id: number; storedFingerprint: string | null }>(
  model: string,
  items: T[],
  textOf: (item: T) => string | null,
): { summary: HistoryEmbeddingSummary; pending: Pending[]; stale: number[] } {
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
  const pending: Pending[] = [];
  const stale: number[] = [];

  for (const item of items) {
    const text = textOf(item);
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
    pending.push({ id: item.id, text, fingerprint, changed: item.storedFingerprint !== null });
  }
  return { summary, pending, stale };
}

function dryRun(summary: HistoryEmbeddingSummary, pending: Pending[], stale: number[]): HistoryEmbeddingSummary {
  summary.removedStale = stale.length;
  summary.embedded = pending.filter((item) => !item.changed).length;
  summary.reembedded = pending.length - summary.embedded;
  return summary;
}

async function embedPending(
  input: EmbedOptions,
  summary: HistoryEmbeddingSummary,
  pending: Pending[],
  store: (request: Pending[], vectors: number[][]) => Promise<void>,
): Promise<void> {
  const requests = packByBudget(pending, (item) => item.text.length, EMBEDDING_REQUEST_MAX_CHARS).flatMap(
    (group) => chunk(group, EMBEDDING_REQUEST_MAX_INPUTS),
  );

  for (const request of requests) {
    input.signal?.throwIfAborted();
    try {
      const result = await input.embeddings.embed(
        request.map((item) => item.text),
        { signal: input.signal },
      );
      summary.requests += 1;
      summary.inputTokens += result.inputTokens;
      await store(request, result.vectors);
      for (const item of request) {
        if (item.changed) summary.reembedded += 1;
        else summary.embedded += 1;
      }
    } catch (error) {
      if (input.signal?.aborted) throw error;
      // One failed request leaves its items for the next run; the rest go on.
      summary.failed += request.length;
      input.logger?.warn('history.embed_request_failed', {
        workspaceId: input.workspaceId,
        items: request.length,
        error: describeError(error),
      });
    }
  }
}

function log(input: EmbedOptions, event: string, summary: HistoryEmbeddingSummary) {
  // Usage under a key the logger does not take for a secret: it redacts anything named *token*.
  const { inputTokens, ...counts } = summary;
  input.logger?.info(event, { ...counts, workspaceId: input.workspaceId, usage: { input: inputTokens } });
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}
