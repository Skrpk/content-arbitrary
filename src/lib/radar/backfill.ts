import type Anthropic from '@anthropic-ai/sdk';
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import { processedPosts, type ApprovalPayload } from '@/db/schema';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import type { TelegramClient } from '@/lib/telegram/client';
import {
  describeStoredMedia,
  RADAR_EXAMPLES_PER_CLASS,
  type RadarImage,
} from '@/lib/radar/prompt';
import { loadRadarHistory } from '@/lib/radar/repository';
import { scoreAndRecord } from '@/lib/radar/shadow';

/**
 * Score posts the editor has already decided, as Radar would have scored them
 * when they arrived.
 *
 * Each post sees only the decisions made before it was first synced — what a
 * live Radar would have had — so the backfill measures prediction, not
 * hindsight. Posts that arrived before there was enough history are left out,
 * as are posts already scored under the current setup, so a run can be
 * interrupted and resumed.
 */

const BACKFILL_CALL_TIMEOUT_MS = 60_000;
/** The API refuses larger images; Telegram's stored photos are well under it. */
const MAX_IMAGE_BYTES = 3_500_000;

export interface BackfillSummary {
  candidates: number;
  scored: number;
  failed: number;
  alreadyScored: number;
  notEnoughHistory: number;
}

export async function runRadarBackfill(input: {
  db: Database;
  client: Anthropic;
  /** Fetches the stored photos for the text_image variant; without it only text is scored. */
  telegram?: TelegramClient;
  workspaceId: number;
  profile: string;
  /** Fewest approvals and fewest rejections a post needs behind it to be scored. */
  minPerClass: number;
  limit?: number;
  concurrency?: number;
  logger: Logger;
  onProgress?: (done: number, total: number) => void;
}): Promise<BackfillSummary> {
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
    .limit(input.limit ?? 10_000);

  const summary: BackfillSummary = {
    candidates: candidates.length,
    scored: 0,
    failed: 0,
    alreadyScored: 0,
    notEnoughHistory: 0,
  };

  let done = 0;
  const queue = [...candidates];

  const worker = async () => {
    for (let post = queue.shift(); post; post = queue.shift()) {
      const history = await loadRadarHistory(input.db, {
        workspaceId: input.workspaceId,
        before: post.createdAt,
        excludePostId: post.id,
        perClass: RADAR_EXAMPLES_PER_CLASS,
      });
      const approvals = history.examples.filter((example) => example.decision === 'approve').length;
      const rejections = history.examples.length - approvals;

      if (approvals < input.minPerClass || rejections < input.minPerClass) {
        summary.notEnoughHistory += 1;
      } else {
        const outcomes = await scoreAndRecord(
          input.db,
          input.client,
          {
            workspaceId: input.workspaceId,
            processedPostId: post.id,
            profile: input.profile,
            item: {
              sourceUsername: post.sourceUsername ?? 'unknown',
              text: post.sourceText ?? '',
              media: describeStoredMedia(post.method, post.mediaCount),
            },
            image: input.telegram
              ? await storedImage(input.telegram, post.approvalPayload, input.logger)
              : undefined,
          },
          {
            mode: 'backfill',
            before: post.createdAt,
            timeoutMs: BACKFILL_CALL_TIMEOUT_MS,
            logger: input.logger,
          },
        );

        if (outcomes.includes('exists')) summary.alreadyScored += 1;
        else if (outcomes.includes('failed')) summary.failed += 1;
        else summary.scored += 1;
      }

      done += 1;
      input.onProgress?.(done, candidates.length);
    }
  };

  await Promise.all(Array.from({ length: input.concurrency ?? 3 }, worker));
  return summary;
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
