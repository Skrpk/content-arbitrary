import type { ApprovalMediaItem, ReviewMediaItem, Source } from '@/db/schema';
import type { Database } from '@/lib/db';
import type { Env } from '@/lib/env';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import type { TelegramClient } from '@/lib/telegram/client';
import { TELEGRAM_MIN_DELAY_BETWEEN_SENDS_MS } from '@/lib/telegram/limits';
import { syncStateKey, updateSourceUsername } from '@/lib/sources/repository';
import { processPost } from '@/lib/sync/process-post';
import {
  claimPost,
  findTerminalPostIds,
  getSyncState,
  markAwaitingApproval,
  markFailed,
  markPending,
  markPublished,
  markSkipped,
  upsertSyncState,
} from '@/lib/sync/repository';
import type { XClient } from '@/lib/x/client';
import { compareSnowflake, getNewPosts } from '@/lib/x/get-new-posts';
import type { TelegramDestination } from '@/lib/workspace';
import type { NormalizedPost, SourceSyncSummary } from '@/types';
import { describeMedia, type RadarImage } from '@/lib/radar/prompt';
import { loadRadarNote } from '@/lib/radar/review-note';
import { runLiveRadar, type RadarRun } from '@/lib/radar/shadow';
import { translateForReview, type Translator } from '@/lib/translation/translate';
import type { PostFooter } from '@/lib/telegram/post-footer';

/**
 * One synchronisation pass over a single X account.
 *
 * Each source keeps its own `sync_state` cursor, keyed `x:<userId>`, so adding
 * or removing accounts never disturbs the others' positions. This function
 * never throws: a source that fails reports the reason in its summary so the
 * orchestrator can carry on with the next one.
 */

export interface SourceSyncContext {
  db: Database;
  env: Env;
  logger: Logger;
  xClient: XClient;
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
  /** When to stop taking new posts (epoch ms); unset, there is no limit. */
  deadline?: number;
  now?: () => number;
}

export async function syncXSource(
  source: Source,
  context: SourceSyncContext,
): Promise<SourceSyncSummary> {
  const { db, env, xClient, telegramClient, sleep } = context;
  const stateKey = syncStateKey(source);
  const logger = context.logger.child({ source: stateKey, username: source.username });

  const summary: SourceSyncSummary = {
    sourceId: source.id,
    workspaceId: source.workspaceId,
    platform: source.platform,
    externalId: source.externalId,
    username: source.username,
    checked: 0,
    newPosts: 0,
    published: 0,
    awaitingApproval: 0,
    failed: 0,
    skipped: 0,
  };

  try {
    const state = await getSyncState(db, stateKey, source.workspaceId);
    await upsertSyncState(db, {
      source: stateKey,
      workspaceId: source.workspaceId,
      lastSyncAt: new Date(),
    });

    const result = await getNewPosts(xClient, {
      userId: source.externalId,
      fallbackUsername: source.username,
      sinceId: state?.lastSeenPostId ?? null,
      fetchLimit: env.X_FETCH_LIMIT,
      includeReplies: env.INCLUDE_REPLIES,
      includeReposts: env.INCLUDE_REPOSTS,
      includeQuotes: env.INCLUDE_QUOTES,
      includeTextOnly: source.includeTextOnly,
      logger,
    });

    summary.checked = result.checked;
    if (result.overflow) summary.windowOverflow = true;

    logger.info('sync.fetched', {
      checked: result.checked,
      pages: result.pages,
      posts: result.posts.length,
      sinceId: state?.lastSeenPostId ?? null,
      newestId: result.newestId,
    });

    // X is the authority on the handle; refresh our cached copy after a rename.
    const observed = result.posts[0]?.authorUsername;
    if (observed && observed.toLowerCase() !== source.username.toLowerCase()) {
      logger.info('source.username_changed', { from: source.username, to: observed });
      await updateSourceUsername(db, { id: source.id, username: observed });
      summary.username = observed;
    }

    for (const entry of result.skipped) {
      logger.info('sync.post_skipped', { xPostId: entry.id, reason: entry.reason });
      summary.skipped += 1;
    }

    /**
     * A source follows its account from the moment it was added or last
     * resumed: the posts already on the timeline then are a backlog, not
     * news, so they are passed over — on the first run, after a pause, and
     * after the account is removed and added back, when the cursor left
     * behind would otherwise replay the gap. The cursor still moves past
     * them, so they are read once and never again.
     */
    const fresh = result.posts.filter((post) => {
      if (!post.createdAt || post.createdAt >= source.followingSince) return true;
      logger.info('sync.post_skipped', { xPostId: post.id, reason: 'posted before the source was followed' });
      summary.skipped += 1;
      return false;
    });

    // Drop anything already settled before we spend a claim on it.
    const terminal = await findTerminalPostIds(
      db,
      fresh.map((post) => post.id),
      source.workspaceId,
    );
    const candidates = fresh.filter((post) => {
      if (!terminal.has(post.id)) return true;
      logger.info('sync.post_skipped', { xPostId: post.id, reason: 'already processed' });
      summary.skipped += 1;
      return false;
    });

    const batch = candidates.slice(0, env.MAX_POSTS_PER_RUN);
    if (candidates.length > batch.length) {
      logger.info('sync.batch_limited', {
        available: candidates.length,
        processing: batch.length,
        maxPostsPerRun: env.MAX_POSTS_PER_RUN,
      });
    }

    summary.newPosts = batch.length;

    /**
     * Highest post id this run reached a terminal decision on. The cursor may
     * never move past it, because anything newer was not even claimed.
     */
    let lastSettledId: string | null = null;
    const settle = (postId: string) => {
      if (lastSettledId === null || compareSnowflake(postId, lastSettledId) > 0) {
        lastSettledId = postId;
      }
    };

    const now = context.now ?? Date.now;

    // Oldest → newest, so the channel reads in the original order.
    for (const [index, post] of batch.entries()) {
      // Out of time: leave the rest for the next run rather than be killed
      // halfway through a post. Nothing unreached is lost — see the cursor below.
      if (context.deadline !== undefined && now() >= context.deadline) {
        summary.stoppedForTime = true;
        summary.newPosts -= batch.length - index;
        logger.warn('sync.time_budget_reached', { unprocessed: batch.length - index });
        break;
      }

      const postLogger = logger.child({ xPostId: post.id });

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
        continue;
      }

      // Space out sends so a burst of new posts does not trip flood control.
      if (index > 0 && !env.DRY_RUN) await sleep(TELEGRAM_MIN_DELAY_BETWEEN_SENDS_MS);

      try {
        const outcome = await processPost(post, {
          client: telegramClient,
          logger: postLogger,
          env,
          sleep,
          fetchImpl: context.fetchImpl,
          postId: claim.row.id,
          destination: context.destination,
          textOnly: source.includeTextOnly,
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
                    processedPostId: claim.row!.id,
                    profile: context.radar!.profile,
                    item: {
                      sourceUsername: post.authorUsername,
                      text: post.text,
                      media: describeMedia(post.media),
                    },
                    image: firstImage(post),
                  },
                  postLogger,
                );
                // The score just recorded, for the reviewer to see beside the buttons.
                return loadRadarNote(db, claim.row!.id);
              }
            : undefined,
        });

        if (outcome.status === 'published') {
          await markPublished(db, {
            id: claim.row.id,
            telegramChatId: context.destination.chatId,
            primaryMessageId: outcome.primaryMessageId,
            telegramMethod: outcome.method,
            mediaCount: outcome.mediaCount,
            messages: outcome.messages,
            caption: outcome.caption,
          });
          settle(post.id);
          summary.published += 1;
          continue;
        }

        /**
         * Sent to the reviewer. The post is settled as far as this run is
         * concerned — the cursor may move past it — but it is not published
         * until the Approve button reaches the webhook.
         */
        if (outcome.status === 'awaiting-approval' && outcome.approval) {
          await markAwaitingApproval(db, {
            id: claim.row.id,
            payload: outcome.approval.payload,
            adminChatId: outcome.approval.adminChatId,
            adminMessageId: outcome.approval.adminMessageId,
            reviewMedia: reviewMediaOf(post, outcome.approval.payload.items),
          });
          settle(post.id);
          summary.awaitingApproval += 1;
          continue;
        }

        if (outcome.status === 'dry-run') {
          // Leave the row `pending` so the first real run publishes it.
          await markPending(db, {
            id: claim.row.id,
            telegramMethod: outcome.method,
            mediaCount: outcome.mediaCount,
          });
          summary.published += 1;
          continue;
        }

        if (outcome.status === 'skipped') {
          await markSkipped(db, { id: claim.row.id, reason: outcome.error ?? 'skipped' });
          settle(post.id);
          summary.newPosts -= 1;
          summary.skipped += 1;
          continue;
        }

        await markFailed(db, {
          id: claim.row.id,
          errorMessage: outcome.error ?? 'unknown error',
          permanent: Boolean(outcome.permanent),
          maxRetryAttempts: env.MAX_RETRY_ATTEMPTS,
        });
        summary.failed += 1;
      } catch (error) {
        // A single post must never abort the batch: record it and continue so
        // that later posts still get published.
        postLogger.error('sync.post_error', { error: describeError(error) });
        await markFailed(db, {
          id: claim.row.id,
          errorMessage: describeError(error),
          permanent: false,
          maxRetryAttempts: env.MAX_RETRY_ATTEMPTS,
        }).catch(() => {});
        summary.failed += 1;
      }
    }

    /**
     * Advance the cursor only as far as this run actually got.
     *
     * Two ways to move it too far, both of which silently lose posts:
     *   - past a post that failed — `since_id` would hide it from every future
     *     run, so any failure pins the cursor where it is;
     *   - past posts the batch never reached, when MAX_POSTS_PER_RUN caps the
     *     run below the number of pending posts. Those were never claimed and
     *     have no row, so only `since_id` could bring them back.
     *
     * `newestId` covers the whole fetched window (including posts filtered out
     * as replies or as having no media), so it is only safe once every
     * candidate has been settled — not when the run stopped short for time.
     */
    const consumedWholeWindow = !summary.stoppedForTime && batch.length === candidates.length;
    const nextCursor =
      summary.failed > 0 ? null : consumedWholeWindow ? result.newestId : lastSettledId;

    await upsertSyncState(db, {
      source: stateKey,
      workspaceId: source.workspaceId,
      ...(nextCursor !== null && !env.DRY_RUN ? { lastSeenPostId: nextCursor } : {}),
      lastSuccessfulSyncAt: new Date(),
      lastError: null,
    });

    logger.info('sync.source_end', {
      ...summary,
      cursorAdvanced: nextCursor !== null && !env.DRY_RUN,
      lastSeenPostId: nextCursor,
    });

    return summary;
  } catch (error) {
    // Never rethrow: one unreachable account must not stop the others.
    const message = describeError(error);
    summary.error = message;

    logger.error('sync.source_failed', { error: message });
    await upsertSyncState(db, {
      source: stateKey,
      workspaceId: source.workspaceId,
      lastError: message,
    }).catch(() => {});

    return summary;
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
