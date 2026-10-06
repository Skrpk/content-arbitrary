import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import { processedPosts, type ApprovalPayload, type RadarVariant } from '@/db/schema';
import { describeError } from '@/lib/errors';
import { scrub, type Logger } from '@/lib/logger';
import type { TelegramClient } from '@/lib/telegram/client';
import {
  describeStoredMedia,
  RADAR_EXAMPLES_PER_CLASS,
  RADAR_PROMPT_VERSION,
  type RadarImage,
} from '@/lib/radar/prompt';
import type { RadarProvider } from '@/lib/radar/providers';
import {
  findEvaluatedVariants,
  loadRadarHistory,
  recordBackfillEvaluation,
} from '@/lib/radar/repository';

/**
 * Score posts the editor has already decided, as Radar would have scored them
 * when they arrived — through the provider's batch API, at half the price.
 *
 * Each post sees only the decisions made before it was first synced — what a
 * live Radar would have had — so the backfill measures prediction, not
 * hindsight. Posts that arrived before there was enough history are left out.
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
  batchIds: string[];
}

export interface IngestSummary {
  scored: number;
  failed: number;
}

/** `p<processed post id>-<variant>`: what ties a batch result back to its post. */
export function radarCustomId(processedPostId: number, variant: RadarVariant): string {
  return `p${processedPostId}-${variant}`;
}

function parseCustomId(customId: string): { processedPostId: number; variant: RadarVariant } | null {
  const match = /^p(\d+)-(text|text_image)$/.exec(customId);
  return match ? { processedPostId: Number(match[1]), variant: match[2] as RadarVariant } : null;
}

export async function submitRadarBackfill(input: {
  db: Database;
  provider: RadarProvider;
  /** Fetches the stored photos for the text_image variant; without it only text is scored. */
  telegram?: TelegramClient;
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
      approvalPayload: processedPosts.approvalPayload,
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
    batchIds: [],
  };

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

    const done = await findEvaluatedVariants(input.db, {
      processedPostId: post.id,
      mode: 'backfill',
      model: input.provider.model,
      promptVersion: RADAR_PROMPT_VERSION,
      scoredOnly: true,
    });
    const wantsImage = Boolean(input.telegram) && hasStoredPhoto(post.approvalPayload);
    if (done.has('text') && (done.has('text_image') || !wantsImage)) {
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

    const image =
      input.telegram && wantsImage && !done.has('text_image')
        ? await storedImage(input.telegram, post.approvalPayload, input.logger)
        : undefined;

    const variants = (['text', ...(image ? ['text_image'] : [])] as RadarVariant[]).filter(
      (candidate) => !done.has(candidate),
    );
    if (variants.length === 0) {
      // Only the image variant was missing, and the image is not available.
      summary.alreadyScored += 1;
      continue;
    }

    summary.posts += 1;
    for (const variant of variants) {
      const request = input.provider.batchEntry(radarCustomId(post.id, variant), {
        profile: input.profile,
        approvalRate: history.approvalRate,
        item: {
          sourceUsername: post.sourceUsername ?? 'unknown',
          text: post.sourceText ?? '',
          media: describeStoredMedia(post.method, post.mediaCount),
        },
        examples: history.examples,
        image: variant === 'text_image' ? image : undefined,
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
  logger: Logger;
}): Promise<IngestSummary> {
  const summary: IngestSummary = { scored: 0, failed: 0 };
  const posts = new Map<number, { examplePostIds: number[] } | null>();

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
        .select({ createdAt: processedPosts.createdAt })
        .from(processedPosts)
        .where(
          and(eq(processedPosts.id, key.processedPostId), eq(processedPosts.workspaceId, input.workspaceId)),
        );
      posts.set(
        key.processedPostId,
        post
          ? {
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

    const base = {
      workspaceId: input.workspaceId,
      processedPostId: key.processedPostId,
      mode: 'backfill' as const,
      variant: key.variant,
      model: input.provider.model,
      promptVersion: RADAR_PROMPT_VERSION,
      imageIncluded: key.variant === 'text_image',
      examplePostIds: post.examplePostIds,
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

function hasStoredPhoto(payload: ApprovalPayload | null): boolean {
  return payload?.items[0]?.kind === 'photo';
}

/**
 * The post's first photo, as the reviewer received it. A video has no stored
 * still, so a video post is scored on its text only.
 */
async function storedImage(
  telegram: TelegramClient,
  payload: ApprovalPayload | null,
  logger: Logger,
): Promise<RadarImage | undefined> {
  const first = payload?.items[0];
  if (!first || first.kind !== 'photo') return undefined;

  try {
    const { bytes, filePath } = await telegram.downloadFile(first.fileId);
    const mediaType = mediaTypeFor(filePath);
    if (!mediaType || bytes.byteLength > MAX_IMAGE_BYTES) return undefined;
    return { kind: 'base64', mediaType, data: Buffer.from(bytes).toString('base64') };
  } catch (error) {
    // Scored on its text alone rather than not at all.
    logger.warn('radar.backfill_image_unavailable', { error: describeError(error) });
    return undefined;
  }
}

function mediaTypeFor(filePath: string): 'image/jpeg' | 'image/png' | 'image/webp' | undefined {
  const extension = filePath.split('.').pop()?.toLowerCase();
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  return undefined;
}
