import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import {
  processedPosts,
  type HistoryRetrievalRecord,
  type RadarVariant,
  type ReviewMediaItem,
} from '@/db/schema';
import { describeError } from '@/lib/errors';
import { scrub, type Logger } from '@/lib/logger';
import type { TelegramClient } from '@/lib/telegram/client';
import {
  describeStoredMedia,
  RADAR_EXAMPLES_PER_CLASS,
  RADAR_PROMPT_BASELINE,
  RADAR_PROMPT_APPROVED,
  RADAR_PROMPT_RETRIEVAL,
  RADAR_PROMPT_VERSIONS,
  usesApprovedRetrieval,
  usesHistoryRetrieval,
  type RadarImage,
  type RadarPromptVersion,
} from '@/lib/radar/prompt';
import type { RadarProvider } from '@/lib/radar/providers';
import {
  findEvaluatedVariants,
  loadRadarHistory,
  recordBackfillEvaluation,
} from '@/lib/radar/repository';
import { loadRadarPublicationProfile } from '@/lib/history/profile/repository';
import type { EmbeddingProvider } from '@/lib/history/embeddings/provider';
import {
  replaySimilarPublications,
  retrieveSimilarPublications,
  toRetrievalRecord,
  type HistoryRetrieval,
} from '@/lib/history/embeddings/retrieval';

/**
 * Score posts the editor has already decided, as Radar would have scored them
 * when they arrived — through the provider's batch API, at half the price.
 *
 * Each post sees only the decisions made before it was first synced — what a
 * live Radar would have had — so the backfill measures prediction, not
 * hindsight. Posts that arrived before there was enough history are left out.
 * The same goes for the publication-history profile: a post gets one only if
 * every publication it was made from predates the post's arrival; otherwise
 * it is scored without one. The retrieval prompt's similar past publications
 * are searched with the same cutoff, in the query itself: only what the
 * channel had published before the post arrived.
 *
 * It runs in two halves, so either can be repeated on its own: submit builds
 * the requests and sends them as one or more batches; ingest reads a finished
 * batch back into radar_evaluations. A score already recorded is never
 * requested or overwritten again; a failed one is retried by the next submit.
 */

/** The API refuses larger images; Telegram's stored photos are well under it. */
const MAX_IMAGE_BYTES = 3_500_000;
/**
 * Where a batch is cut. Anthropic takes up to 256 MB and 100,000 requests,
 * OpenAI 200 MB and 50,000; staying well below both keeps a batch of
 * photo-heavy requests safely inside either.
 */
const MAX_BATCH_BYTES = 100_000_000;
const MAX_BATCH_REQUESTS = 10_000;

export interface SubmitSummary {
  candidates: number;
  notEnoughHistory: number;
  alreadyScored: number;
  /** Posts sent for scoring; each is one request, or two with a photo. */
  posts: number;
  requests: number;
  /**
   * Posts whose similar-publication search failed: their retrieval-prompt
   * requests are held back, so the next submit retries them rather than
   * recording a retrieval score made without retrieval.
   */
  retrievalFailed: number;
  batchIds: string[];
}

export interface IngestSummary {
  scored: number;
  failed: number;
}

/**
 * A prompt version's mark in a custom id. Batch custom ids are limited to 64
 * characters, so the version is abbreviated; the baseline has none, which
 * also reads batches submitted before there were two versions correctly.
 */
const PROMPT_TAGS: Record<RadarPromptVersion, string> = {
  [RADAR_PROMPT_BASELINE]: '',
  [RADAR_PROMPT_RETRIEVAL]: 'v2r',
  [RADAR_PROMPT_APPROVED]: 'v3a',
};

/**
 * `p<processed post id>-<variant>[-h<history profile id>][-<prompt tag>]`:
 * what ties a batch result back to its post, to the publication-history
 * profile its prompt carried — which a later profile must not be mistaken for
 * at ingest — and to the prompt version that asked.
 */
export function radarCustomId(
  processedPostId: number,
  variant: RadarVariant,
  historyProfileId?: number | null,
  promptVersion: RadarPromptVersion = RADAR_PROMPT_BASELINE,
): string {
  const tag = PROMPT_TAGS[promptVersion];
  return `p${processedPostId}-${variant}${historyProfileId ? `-h${historyProfileId}` : ''}${tag ? `-${tag}` : ''}`;
}

function parseCustomId(customId: string): {
  processedPostId: number;
  variant: RadarVariant;
  historyProfileId: number | null;
  promptVersion: RadarPromptVersion;
} | null {
  const match = /^p(\d+)-(text|text_image)(?:-h(\d+))?(?:-([a-z0-9]+))?$/.exec(customId);
  if (!match) return null;
  const promptVersion = RADAR_PROMPT_VERSIONS.find((version) => PROMPT_TAGS[version] === (match[4] ?? ''));
  return promptVersion
    ? {
        processedPostId: Number(match[1]),
        variant: match[2] as RadarVariant,
        historyProfileId: match[3] ? Number(match[3]) : null,
        promptVersion,
      }
    : null;
}

export async function submitRadarBackfill(input: {
  db: Database;
  provider: RadarProvider;
  /** Fetches the reviewer's copy of a photo; without it, X's URL is used. */
  telegram?: TelegramClient;
  /** Score the text only, never the image. */
  textOnly?: boolean;
  /** Which prompts to score with; every version by default, so they compare on the same posts. */
  promptVersions?: readonly RadarPromptVersion[];
  /** For the retrieval prompt's similar past publications. */
  embeddings?: EmbeddingProvider | null;
  workspaceId: number;
  profile: string;
  /** Fewest approvals and fewest rejections a post needs behind it to be scored. */
  minPerClass: number;
  /** Most posts to score this run — counting only posts that are sent, not ones passed over. */
  limit?: number;
  logger: Logger;
  maxBatchBytes?: number;
}): Promise<SubmitSummary> {
  const candidates = await input.db
    .select({
      id: processedPosts.id,
      createdAt: processedPosts.createdAt,
      sourceUsername: processedPosts.xAuthorUsername,
      sourceText: processedPosts.sourceText,
      method: processedPosts.telegramMethod,
      mediaCount: processedPosts.mediaCount,
      reviewMedia: processedPosts.reviewMedia,
    })
    .from(processedPosts)
    .where(
      and(
        eq(processedPosts.workspaceId, input.workspaceId),
        isNotNull(processedPosts.reviewedAt),
        isNotNull(processedPosts.sourceText),
        inArray(processedPosts.status, ['published', 'scheduled', 'rejected']),
      ),
    )
    .orderBy(asc(processedPosts.createdAt));

  const summary: SubmitSummary = {
    candidates: candidates.length,
    notEnoughHistory: 0,
    alreadyScored: 0,
    posts: 0,
    requests: 0,
    retrievalFailed: 0,
    batchIds: [],
  };
  const versions = input.promptVersions ?? RADAR_PROMPT_VERSIONS;

  const maxBytes = input.maxBatchBytes ?? MAX_BATCH_BYTES;
  let pending: unknown[] = [];
  let pendingBytes = 0;

  const flush = async () => {
    if (pending.length === 0) return;
    const batchId = await input.provider.submitBatch(pending);
    summary.batchIds.push(batchId);
    input.logger.info('radar.batch_submitted', {
      provider: input.provider.name,
      batchId,
      requests: pending.length,
    });
    pending = [];
    pendingBytes = 0;
  };

  for (const post of candidates) {
    if (input.limit !== undefined && summary.posts >= input.limit) break;

    const wantsImage = !input.textOnly && hasReviewImage(post.reviewMedia);
    const wanted: RadarVariant[] = wantsImage ? ['text', 'text_image'] : ['text'];
    const missing: { version: RadarPromptVersion; variant: RadarVariant }[] = [];
    for (const version of versions) {
      const done = await findEvaluatedVariants(input.db, {
        processedPostId: post.id,
        mode: 'backfill',
        model: input.provider.model,
        promptVersion: version,
        scoredOnly: true,
      });
      for (const variant of wanted) if (!done.has(variant)) missing.push({ version, variant });
    }
    if (missing.length === 0) {
      summary.alreadyScored += 1;
      continue;
    }

    const history = await loadRadarHistory(input.db, {
      workspaceId: input.workspaceId,
      before: post.createdAt,
      excludePostId: post.id,
      perClass: RADAR_EXAMPLES_PER_CLASS,
    });
    const approvals = history.examples.filter((example) => example.decision === 'approve').length;
    if (approvals < input.minPerClass || history.examples.length - approvals < input.minPerClass) {
      summary.notEnoughHistory += 1;
      continue;
    }

    const image = missing.some(({ variant }) => variant === 'text_image')
      ? await reviewImage(input.telegram, post.reviewMedia, input.logger)
      : undefined;

    // The image variant is dropped when the image is not available.
    let requests = missing.filter(({ variant }) => variant === 'text' || image);
    const publication = await loadRadarPublicationProfile(input.db, {
      workspaceId: input.workspaceId,
      arrivedAt: post.createdAt,
      logger: input.logger,
    });
    if (requests.length === 0) {
      summary.alreadyScored += 1;
      continue;
    }

    const retrieval = requests.some(({ version }) => usesHistoryRetrieval(version))
      ? await retrieveSimilarPublications({
          db: input.db,
          embeddings: input.embeddings ?? null,
          workspaceId: input.workspaceId,
          processedPostId: post.id,
          candidateText: post.sourceText,
          before: post.createdAt,
          includeApproved: requests.some(({ version }) => usesApprovedRetrieval(version)),
          logger: input.logger,
        })
      : null;
    if (retrieval?.status === 'failed') {
      summary.retrievalFailed += 1;
      requests = requests.filter(({ version }) => !usesHistoryRetrieval(version));
      if (requests.length === 0) continue;
    }

    summary.posts += 1;
    for (const { version, variant } of requests) {
      const customId = radarCustomId(post.id, variant, publication?.id, version);
      const request = input.provider.batchEntry(customId, {
        profile: input.profile,
        approvalRate: history.approvalRate,
        item: {
          sourceUsername: post.sourceUsername ?? 'unknown',
          text: post.sourceText ?? '',
          media: describeStoredMedia(post.method, post.mediaCount),
        },
        examples: history.examples,
        image: variant === 'text_image' ? image : undefined,
        publicationProfile: publication?.profile ?? null,
        promptVersion: version,
        similarPublications: usesHistoryRetrieval(version) ? (retrieval?.matches ?? []) : null,
        similarApproved: usesApprovedRetrieval(version) ? (retrieval?.approved?.matches ?? []) : null,
      });

      const bytes = JSON.stringify(request).length;
      if (pending.length > 0 && (pendingBytes + bytes > maxBytes || pending.length >= MAX_BATCH_REQUESTS)) {
        await flush();
      }
      pending.push(request);
      pendingBytes += bytes;
      summary.requests += 1;
    }
  }

  await flush();
  return summary;
}

/** Wait for a batch to finish. Batches usually take minutes, at most 24 hours. */
export async function waitForBatch(
  provider: RadarProvider,
  batchId: string,
  options: {
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onStatus?: (status: string) => void;
  } = {},
): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    const { ended, status } = await provider.pollBatch(batchId);
    options.onStatus?.(status);
    if (ended) return;
    await sleep(options.pollMs ?? 30_000);
  }
}

/**
 * Read a finished batch into radar_evaluations. Safe to repeat: a score
 * already recorded stays as it is.
 */
export async function ingestRadarBatch(input: {
  db: Database;
  provider: RadarProvider;
  batchId: string;
  workspaceId: number;
  /** The embedding model the requests were searched with; needed to record what they were shown. */
  embeddingModel?: string | null;
  logger: Logger;
}): Promise<IngestSummary> {
  const summary: IngestSummary = { scored: 0, failed: 0 };
  const posts = new Map<
    number,
    { createdAt: Date; sourceText: string | null; examplePostIds: number[] } | null
  >();
  const retrievals = new Map<number, HistoryRetrieval | null>();

  for await (const result of input.provider.batchResults(input.batchId)) {
    const key = parseCustomId(result.customId);
    if (!key) {
      input.logger.warn('radar.batch_unknown_result', { customId: result.customId });
      continue;
    }

    // The examples are not stored with the batch; they are the same history
    // the request was built from, read again with the same cutoff.
    if (!posts.has(key.processedPostId)) {
      const [post] = await input.db
        .select({ createdAt: processedPosts.createdAt, sourceText: processedPosts.sourceText })
        .from(processedPosts)
        .where(
          and(eq(processedPosts.id, key.processedPostId), eq(processedPosts.workspaceId, input.workspaceId)),
        );
      posts.set(
        key.processedPostId,
        post
          ? {
              ...post,
              examplePostIds: (
                await loadRadarHistory(input.db, {
                  workspaceId: input.workspaceId,
                  before: post.createdAt,
                  excludePostId: key.processedPostId,
                  perClass: RADAR_EXAMPLES_PER_CLASS,
                })
              ).examples.map((example) => example.postId),
            }
          : null,
      );
    }
    const post = posts.get(key.processedPostId);
    if (!post) {
      // Deleted since, or another tenant's batch.
      input.logger.warn('radar.batch_result_without_post', { customId: result.customId });
      continue;
    }

    // Like the examples, what the search found is read again: the same
    // search, from the vector stored when the request was built.
    let historyRetrieval: HistoryRetrievalRecord | null = null;
    if (usesHistoryRetrieval(key.promptVersion)) {
      if (!retrievals.has(key.processedPostId)) {
        // Both searches, whichever version asks first; each keeps its own part.
        retrievals.set(
          key.processedPostId,
          input.embeddingModel
            ? await replaySimilarPublications({
                db: input.db,
                model: input.embeddingModel,
                workspaceId: input.workspaceId,
                processedPostId: key.processedPostId,
                candidateText: post.sourceText,
                before: post.createdAt,
                includeApproved: true,
              })
            : null,
        );
      }
      const replayed = retrievals.get(key.processedPostId);
      const withApproved = usesApprovedRetrieval(key.promptVersion);
      historyRetrieval = replayed
        ? toRetrievalRecord(replayed, { approved: withApproved })
        : {
            status: 'unavailable',
            embeddingModel: null,
            matches: [],
            ...(withApproved ? { approved: { status: 'unavailable' as const, matches: [] } } : {}),
          };
    }

    const base = {
      workspaceId: input.workspaceId,
      processedPostId: key.processedPostId,
      mode: 'backfill' as const,
      variant: key.variant,
      model: input.provider.model,
      promptVersion: key.promptVersion,
      imageIncluded: key.variant === 'text_image',
      examplePostIds: post.examplePostIds,
      publicationHistoryProfileId: key.historyProfileId,
      historyRetrieval,
    };

    if (result.ok) {
      const { prediction } = result;
      await recordBackfillEvaluation(input.db, {
        ...base,
        status: 'ok',
        score: prediction.score,
        predictedDecision: prediction.predictedDecision,
        topicFit: prediction.topicFit,
        editorialFit: prediction.editorialFit,
        importance: prediction.importance,
        reason: prediction.reason,
        predictedRejectionReason: prediction.predictedRejectionReason,
        historicalAssessment: historyRetrieval ? prediction.historicalAssessment : null,
        inputTokens: prediction.inputTokens,
        outputTokens: prediction.outputTokens,
      });
      summary.scored += 1;
    } else {
      await recordBackfillEvaluation(input.db, {
        ...base,
        status: 'failed',
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
        error: scrub(result.error).slice(0, 500),
      });
      summary.failed += 1;
    }
  }

  return summary;
}

/** Whether the post's first item has a picture to show: a photo, or a video's still. */
function hasReviewImage(media: ReviewMediaItem[] | null): boolean {
  const first = media?.[0];
  if (!first) return false;
  return first.kind === 'photo' ? Boolean(first.fileId || first.url) : Boolean(first.previewUrl);
}

/**
 * The picture the reviewer saw first. A photo is fetched from Telegram — its
 * copy does not expire — and handed over inline; failing that, and for a
 * video's still, the model is given X's URL, as live scoring is.
 */
async function reviewImage(
  telegram: TelegramClient | undefined,
  media: ReviewMediaItem[] | null,
  logger: Logger,
): Promise<RadarImage | undefined> {
  const first = media?.[0];
  if (!first) return undefined;

  if (first.kind === 'photo' && first.fileId && telegram) {
    try {
      const { bytes, filePath } = await telegram.downloadFile(first.fileId);
      const mediaType = mediaTypeFor(filePath);
      if (mediaType && bytes.byteLength <= MAX_IMAGE_BYTES) {
        return { kind: 'base64', mediaType, data: Buffer.from(bytes).toString('base64') };
      }
    } catch (error) {
      logger.warn('radar.backfill_image_unavailable', { error: describeError(error) });
    }
  }

  const url = first.kind === 'photo' ? first.url : first.previewUrl;
  return url ? { kind: 'url', url } : undefined;
}

function mediaTypeFor(filePath: string): 'image/jpeg' | 'image/png' | 'image/webp' | undefined {
  const extension = filePath.split('.').pop()?.toLowerCase();
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  return undefined;
}
