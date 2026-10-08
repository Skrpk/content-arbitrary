import type { ApprovalMediaItem, ReviewMediaItem, Source } from '@/db/schema';
import type { Database } from '@/lib/db';
import type { Env } from '@/lib/env';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import type { TelegramClient } from '@/lib/telegram/client';
import { TELEGRAM_MIN_DELAY_BETWEEN_SENDS_MS } from '@/lib/telegram/limits';
import type { PostFooter } from '@/lib/telegram/post-footer';
import { processPost } from '@/lib/sync/process-post';
import {
  claimPost,
  markAwaitingApproval,
  markFailed,
  markPending,
  markPublished,
  markSkipped,
} from '@/lib/sync/repository';
import { describeMedia, type RadarImage } from '@/lib/radar/prompt';
import { loadRadarNote } from '@/lib/radar/review-note';
import { runLiveRadar, type RadarRun } from '@/lib/radar/shadow';
import { translateForReview, type Translator } from '@/lib/translation/translate';
import type { TelegramDestination } from '@/lib/workspace';
import type { NormalizedPost, SourceSyncSummary } from '@/types';

/**
 * One candidate, from claim to its recorded outcome — the part every source
 * shares, whatever platform it reads: claim the row, let Radar score it and
 * the translator rewrite it, send it for review (or straight to the channel),
 * and record what happened. A platform's sync decides only which posts are
 * candidates and how far its own cursor may move.
 */

/** What every source's sync needs to hand a post on, whatever its platform. */
export interface CandidateContext {
  db: Database;
  env: Env;
  telegramClient: TelegramClient;
  sleep: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  /** The tenant's channel and reviewer, resolved once per workspace. */
  destination: TelegramDestination;
  /** Set when Shadow Radar scores this tenant's posts before review. */
  radar?: { run: RadarRun; profile: string };
  /** Set when the tenant publishes in a language its posts are rewritten in. */
  translator?: Translator;
  /** The tenant's footer, added under every post. */
  footer?: PostFooter | null;
}

/**
 * Where the candidate ended up. `settled` means a terminal decision was
 * reached this run — what a cursor may move past.
 */
export type CandidateResult =
  | { kind: 'published' | 'awaiting-approval' | 'skipped'; settled: true }
  | { kind: 'dry-run' | 'failed' | 'not-claimed'; settled: false };

/**
 * Claim, process and record one post, counting it in `summary` (whose
 * `newPosts` already includes it). Never throws: a single post must not
 * abort its source's batch.
 */
export async function processCandidate(
  post: NormalizedPost,
  source: Source,
  context: CandidateContext,
  summary: SourceSyncSummary,
  options: { logger: Logger; textOnly: boolean; spaceOut: boolean },
): Promise<CandidateResult> {
  const { db, env } = context;
  const postLogger = options.logger;

  const claim = await claimPost(db, {
    xPostId: post.id,
    xPostUrl: post.url,
    xAuthorUsername: post.authorUsername,
    xCreatedAt: post.createdAt,
    maxRetryAttempts: env.MAX_RETRY_ATTEMPTS,
    sourceId: source.id,
    workspaceId: source.workspaceId,
    sourceText: post.text,
    metrics: post.metrics,
  });

  if (!claim.claimed || !claim.row) {
    // Lost the race, or the row is in a state we must not touch.
    postLogger.info('sync.post_skipped', { reason: claim.reason ?? 'not claimable' });
    summary.newPosts -= 1;
    summary.skipped += 1;
    return { kind: 'not-claimed', settled: false };
  }
  const row = claim.row;

  // Space out sends so a burst of new posts does not trip flood control.
  if (options.spaceOut && !env.DRY_RUN) await context.sleep(TELEGRAM_MIN_DELAY_BETWEEN_SENDS_MS);

  try {
    const outcome = await processPost(post, {
      client: context.telegramClient,
      logger: postLogger,
      env,
      sleep: context.sleep,
      fetchImpl: context.fetchImpl,
      postId: row.id,
      destination: context.destination,
      textOnly: options.textOnly,
      footer: context.footer,
      translate: context.translator
        ? (text) => translateForReview(context.translator!, text, postLogger)
        : undefined,
      beforeReview: context.radar
        ? async () => {
            await runLiveRadar(
              context.radar!.run,
              db,
              {
                workspaceId: source.workspaceId,
                processedPostId: row.id,
                profile: context.radar!.profile,
                item: {
                  sourceUsername: post.authorUsername,
                  ...(post.platform === 'rss' ? { sourcePlatform: 'rss' as const } : {}),
                  text: post.text,
                  media: describeMedia(post.media),
                },
                image: firstImage(post),
              },
              postLogger,
            );
            // The score just recorded, for the reviewer to see beside the buttons.
            return loadRadarNote(db, row.id);
          }
        : undefined,
    });

    if (outcome.status === 'published') {
      await markPublished(db, {
        id: row.id,
        telegramChatId: context.destination.chatId,
        primaryMessageId: outcome.primaryMessageId,
        telegramMethod: outcome.method,
        mediaCount: outcome.mediaCount,
        messages: outcome.messages,
        caption: outcome.caption,
      });
      summary.published += 1;
      return { kind: 'published', settled: true };
    }

    /**
     * Sent to the reviewer. The post is settled as far as this run is
     * concerned — a cursor may move past it — but it is not published until
     * the Approve button reaches the webhook.
     */
    if (outcome.status === 'awaiting-approval' && outcome.approval) {
      await markAwaitingApproval(db, {
        id: row.id,
        payload: outcome.approval.payload,
        adminChatId: outcome.approval.adminChatId,
        adminMessageId: outcome.approval.adminMessageId,
        reviewMedia: reviewMediaOf(post, outcome.approval.payload.items),
      });
      summary.awaitingApproval += 1;
      return { kind: 'awaiting-approval', settled: true };
    }

    if (outcome.status === 'dry-run') {
      // Leave the row `pending` so the first real run publishes it.
      await markPending(db, {
        id: row.id,
        telegramMethod: outcome.method,
        mediaCount: outcome.mediaCount,
      });
      summary.published += 1;
      return { kind: 'dry-run', settled: false };
    }

    if (outcome.status === 'skipped') {
      await markSkipped(db, { id: row.id, reason: outcome.error ?? 'skipped' });
      summary.newPosts -= 1;
      summary.skipped += 1;
      return { kind: 'skipped', settled: true };
    }

    await markFailed(db, {
      id: row.id,
      errorMessage: outcome.error ?? 'unknown error',
      permanent: Boolean(outcome.permanent),
      maxRetryAttempts: env.MAX_RETRY_ATTEMPTS,
    });
    summary.failed += 1;
    return { kind: 'failed', settled: false };
  } catch (error) {
    // A single post must never abort the batch: record it and continue so
    // that later posts still get published.
    postLogger.error('sync.post_error', { error: describeError(error) });
    await markFailed(db, {
      id: row.id,
      errorMessage: describeError(error),
      permanent: false,
      maxRetryAttempts: env.MAX_RETRY_ATTEMPTS,
    }).catch(() => {});
    summary.failed += 1;
    return { kind: 'failed', settled: false };
  }
}

/**
 * What the reviewer was shown: Telegram's file for each item, with X's URLs
 * alongside. The review send keeps the post's media in order and all or
 * nothing, so the two line up; if they ever did not, X's URLs are left out
 * rather than paired with the wrong file.
 */
function reviewMediaOf(post: NormalizedPost, items: ApprovalMediaItem[]): ReviewMediaItem[] {
  const aligned =
    items.length === post.media.length &&
    items.every((item, index) => item.kind === post.media[index]!.kind);

  return items.map((item, index) => {
    const media = aligned ? post.media[index] : undefined;
    return {
      kind: item.kind,
      fileId: item.fileId,
      ...(media?.kind === 'photo' ? { url: media.url } : {}),
      ...(media?.previewUrl ? { previewUrl: media.previewUrl } : {}),
    };
  });
}

/** The picture Radar is shown: the first photo, or the first video's still. */
function firstImage(post: NormalizedPost): RadarImage | undefined {
  const first = post.media[0];
  if (!first) return undefined;
  const url = first.kind === 'photo' ? first.url : first.previewUrl;
  return url ? { kind: 'url', url } : undefined;
}
