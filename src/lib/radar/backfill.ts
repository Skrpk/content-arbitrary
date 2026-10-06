import type Anthropic from '@anthropic-ai/sdk';
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import { processedPosts, type ApprovalPayload, type RadarVariant } from '@/db/schema';
import { describeError } from '@/lib/errors';
import { scrub, type Logger } from '@/lib/logger';
import type { TelegramClient } from '@/lib/telegram/client';
import {
  describeStoredMedia,
  RADAR_EXAMPLES_PER_CLASS,
  RADAR_MODEL,
  RADAR_PROMPT_VERSION,
  type RadarImage,
} from '@/lib/radar/prompt';
import {
  findEvaluatedVariants,
  loadRadarHistory,
  recordBackfillEvaluation,
} from '@/lib/radar/repository';
import { buildRadarRequest, parseRadarMessage, RadarError } from '@/lib/radar/score';

/**
 * Score posts the editor has already decided, as Radar would have scored them
 * when they arrived — through the Message Batches API, at half the price.
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
 * Where a batch is cut. The API takes up to 256 MB and 100,000 requests;
 * staying well below keeps a batch of photo-heavy requests safely inside it.
 */
const MAX_BATCH_BYTES = 100_000_000;
const MAX_BATCH_REQUESTS = 10_000;

export interface SubmitSummary {
  candidates: number;
  notEnoughHistory: number;
  alreadyScored: number;
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
  client: Anthropic;
  /** Fetches the stored photos for the text_image variant; without it only text is scored. */
  telegram?: TelegramClient;
  workspaceId: number;
  profile: string;
  /** Fewest approvals and fewest rejections a post needs behind it to be scored. */
  minPerClass: number;
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
    .orderBy(asc(processedPosts.createdAt))
    .limit(input.limit ?? 100_000);

  const summary: SubmitSummary = {
    candidates: candidates.length,
    notEnoughHistory: 0,
    alreadyScored: 0,
    requests: 0,
    batchIds: [],
  };

  const maxBytes = input.maxBatchBytes ?? MAX_BATCH_BYTES;
  let pending: Anthropic.Messages.BatchCreateParams.Request[] = [];
  let pendingBytes = 0;

  const flush = async () => {
    if (pending.length === 0) return;
    const batch = await input.client.messages.batches.create({ requests: pending });
    summary.batchIds.push(batch.id);
    input.logger.info('radar.batch_submitted', { batchId: batch.id, requests: pending.length });
    pending = [];
    pendingBytes = 0;
  };

  for (const post of candidates) {
    const done = await findEvaluatedVariants(input.db, {
      processedPostId: post.id,
      mode: 'backfill',
      model: RADAR_MODEL,
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

    for (const variant of variants) {
      const request = {
        custom_id: radarCustomId(post.id, variant),
        params: buildRadarRequest({
          profile: input.profile,
          approvalRate: history.approvalRate,
          item: {
            sourceUsername: post.sourceUsername ?? 'unknown',
            text: post.sourceText ?? '',
            media: describeStoredMedia(post.method, post.mediaCount),
          },
          examples: history.examples,
          image: variant === 'text_image' ? image : undefined,
        }),
      };

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
  client: Anthropic,
  batchId: string,
  options: {
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onStatus?: (batch: Anthropic.Messages.MessageBatch) => void;
  } = {},
): Promise<Anthropic.Messages.MessageBatch> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    const batch = await client.messages.batches.retrieve(batchId);
    options.onStatus?.(batch);
    if (batch.processing_status === 'ended') return batch;
    await sleep(options.pollMs ?? 30_000);
  }
}

/**
 * Read a finished batch into radar_evaluations. Safe to repeat: a score
 * already recorded stays as it is.
 */
export async function ingestRadarBatch(input: {
  db: Database;
  client: Anthropic;
  batchId: string;
  workspaceId: number;
  logger: Logger;
}): Promise<IngestSummary> {
  const summary: IngestSummary = { scored: 0, failed: 0 };
  const posts = new Map<number, { createdAt: Date; examplePostIds: number[] } | null>();

  const results = await input.client.messages.batches.results(input.batchId);
  for await (const entry of results) {
    const key = parseCustomId(entry.custom_id);
    if (!key) {
      input.logger.warn('radar.batch_unknown_result', { customId: entry.custom_id });
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
              createdAt: post.createdAt,
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
      input.logger.warn('radar.batch_result_without_post', { customId: entry.custom_id });
      continue;
    }

    const base = {
      workspaceId: input.workspaceId,
      processedPostId: key.processedPostId,
      mode: 'backfill' as const,
      variant: key.variant,
      model: RADAR_MODEL,
      promptVersion: RADAR_PROMPT_VERSION,
      imageIncluded: key.variant === 'text_image',
      examplePostIds: post.examplePostIds,
    };

    if (entry.result.type === 'succeeded') {
      try {
        const prediction = parseRadarMessage(entry.result.message);
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
      } catch (error) {
        const usage = error instanceof RadarError ? error.usage : undefined;
        await recordBackfillEvaluation(input.db, {
          ...base,
          status: 'failed',
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          error: scrub(describeError(error)).slice(0, 500),
        });
        summary.failed += 1;
      }
      continue;
    }

    // errored, expired or canceled: not billed, and retried by the next submit.
    const detail =
      entry.result.type === 'errored'
        ? `${entry.result.error.error.type}: ${entry.result.error.error.message}`
        : entry.result.type;
    await recordBackfillEvaluation(input.db, {
      ...base,
      status: 'failed',
      error: scrub(`batch request ${detail}`).slice(0, 500),
    });
    summary.failed += 1;
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
