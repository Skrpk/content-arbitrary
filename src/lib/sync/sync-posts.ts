import { randomUUID } from 'node:crypto';
import { getDb, getSql, type Database } from '@/lib/db';
import { getEnv, type Env } from '@/lib/env';
import { describeError } from '@/lib/errors';
import { createLogger, type Logger } from '@/lib/logger';
import { TelegramClient } from '@/lib/telegram/client';
import { TELEGRAM_MIN_DELAY_BETWEEN_SENDS_MS } from '@/lib/telegram/limits';
import { XClient } from '@/lib/x/client';
import { compareSnowflake, getNewPosts } from '@/lib/x/get-new-posts';
import { acquireSyncLock } from '@/lib/sync/locks';
import { processPost } from '@/lib/sync/process-post';
import {
  claimPost,
  findTerminalPostIds,
  getSyncState,
  markFailed,
  markPublished,
  markSkipped,
  upsertSyncState,
} from '@/lib/sync/repository';
import { defaultSleep } from '@/lib/sync/retry';
import type { SyncSummary } from '@/types';

/**
 * One complete synchronisation cycle.
 *
 * Safety model, in layers:
 *   1. A Postgres advisory lock means only one invocation runs at a time.
 *   2. An atomic claim on the UNIQUE `x_post_id` means that even if the lock
 *      were bypassed, a post can only ever be claimed by one runner.
 *   3. Each post is processed in isolation, so one bad post cannot abort the batch.
 */

export interface SyncOptions {
  db?: Database;
  env?: Env;
  logger?: Logger;
  telegramClient?: TelegramClient;
  xClient?: XClient;
  sleep?: (ms: number) => Promise<void>;
  /** Overrides the fetch used for media downloads; injected by tests. */
  fetchImpl?: typeof fetch;
  /** Skip the advisory lock (used by the local CLI runner). */
  skipLock?: boolean;
}

export async function syncPosts(options: SyncOptions = {}): Promise<SyncSummary> {
  const env = options.env ?? getEnv();
  const runId = randomUUID().slice(0, 8);
  const logger = (options.logger ?? createLogger({ app: 'content-arbitrary' })).child({ runId });
  const db = options.db ?? getDb();
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = Date.now();

  const summary: SyncSummary = {
    checked: 0,
    newPosts: 0,
    published: 0,
    failed: 0,
    skipped: 0,
    dryRun: env.DRY_RUN,
    durationMs: 0,
    runId,
  };

  logger.info('sync.start', {
    dryRun: env.DRY_RUN,
    maxPostsPerRun: env.MAX_POSTS_PER_RUN,
    includeReplies: env.INCLUDE_REPLIES,
    includeReposts: env.INCLUDE_REPOSTS,
    mediaUploadMode: env.MEDIA_UPLOAD_MODE,
  });

  const lock = options.skipLock
    ? { acquired: true, release: async () => {} }
    : await acquireSyncLock(getSql(), 'content-arbitrary:sync');

  if (!lock.acquired) {
    // Another invocation is mid-run. Exiting immediately is correct: the work
    // is not lost, the in-flight run is already doing it.
    logger.warn('sync.lock_busy', {});
    summary.lockBusy = true;
    summary.durationMs = Date.now() - startedAt;
    logger.info('sync.end', { ...summary });
    return summary;
  }

  try {
    const xClient = options.xClient ?? new XClient({ logger });

    // Resolve the account once, then keep using the numeric id.
    const { userId, username } = await resolveAccount(xClient, env, logger);
    const source = `x:${userId}`;

    const state = await getSyncState(db, source);
    await upsertSyncState(db, { source, lastSyncAt: new Date() });

    const result = await getNewPosts(xClient, {
      userId,
      fallbackUsername: username,
      sinceId: state?.lastSeenPostId ?? null,
      fetchLimit: env.X_FETCH_LIMIT,
      includeReplies: env.INCLUDE_REPLIES,
      includeReposts: env.INCLUDE_REPOSTS,
      includeQuotes: env.INCLUDE_QUOTES,
      logger,
    });

    summary.checked = result.checked;

    logger.info('sync.fetched', {
      checked: result.checked,
      mediaPosts: result.posts.length,
      sinceId: state?.lastSeenPostId ?? null,
      newestId: result.newestId,
    });

    for (const entry of result.skipped) {
      logger.info('sync.post_skipped', { xPostId: entry.id, reason: entry.reason });
      summary.skipped += 1;
    }

    // Drop anything already settled before we spend a claim on it.
    const terminal = await findTerminalPostIds(db, result.posts.map((post) => post.id));
    const candidates = result.posts.filter((post) => {
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

    const telegramClient = options.telegramClient ?? new TelegramClient({ logger });

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

    // Oldest → newest, so the channel reads in the original order.
    for (const [index, post] of batch.entries()) {
      const postLogger = logger.child({ xPostId: post.id });

      const claim = await claimPost(db, {
        xPostId: post.id,
        xPostUrl: post.url,
        xAuthorUsername: post.authorUsername,
        xCreatedAt: post.createdAt,
        maxRetryAttempts: env.MAX_RETRY_ATTEMPTS,
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
          fetchImpl: options.fetchImpl,
        });

        if (outcome.status === 'published') {
          await markPublished(db, {
            id: claim.row.id,
            telegramChatId: env.TELEGRAM_CHAT_ID,
            primaryMessageId: outcome.primaryMessageId,
            telegramMethod: outcome.method,
            mediaCount: outcome.mediaCount,
            messages: outcome.messages,
          });
          settle(post.id);
          summary.published += 1;
          continue;
        }

        if (outcome.status === 'dry-run') {
          // Leave the row `pending` so the first real run publishes it.
          await markPending(db, claim.row.id, outcome.method, outcome.mediaCount);
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
     * candidate has been settled.
     */
    const consumedWholeWindow = batch.length === candidates.length;
    const nextCursor =
      summary.failed > 0
        ? null
        : consumedWholeWindow
          ? result.newestId
          : lastSettledId;

    await upsertSyncState(db, {
      source,
      ...(nextCursor !== null && !env.DRY_RUN ? { lastSeenPostId: nextCursor } : {}),
      lastSuccessfulSyncAt: new Date(),
      lastError: null,
    });

    summary.durationMs = Date.now() - startedAt;
    logger.info('sync.end', {
      ...summary,
      cursorAdvanced: nextCursor !== null && !env.DRY_RUN,
      lastSeenPostId: nextCursor,
    });
    return summary;
  } catch (error) {
    const message = describeError(error);
    summary.error = message;
    summary.durationMs = Date.now() - startedAt;

    logger.error('sync.failed', { error: message });

    await upsertSyncState(db, {
      source: `x:${env.X_USER_ID ?? env.X_USERNAME ?? 'unknown'}`,
      lastError: message,
    }).catch(() => {});

    logger.info('sync.end', { ...summary });
    return summary;
  } finally {
    await lock.release().catch(() => {});
  }
}

async function markPending(
  db: Database,
  id: number,
  method: string,
  mediaCount: number,
): Promise<void> {
  const { processedPosts } = await import('@/db/schema');
  const { eq } = await import('drizzle-orm');

  await db
    .update(processedPosts)
    .set({
      status: 'pending',
      telegramMethod: method,
      mediaCount,
      lockedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(processedPosts.id, id));
}

/**
 * Prefer the configured numeric id; fall back to one handle lookup.
 *
 * Setting X_USER_ID saves an API call (and its cost) on every single run, which
 * is why the README recommends it.
 */
async function resolveAccount(
  xClient: XClient,
  env: Env,
  logger: Logger,
): Promise<{ userId: string; username: string }> {
  if (env.X_USER_ID) {
    return { userId: env.X_USER_ID, username: (env.X_USERNAME ?? '').replace(/^@/, '') || env.X_USER_ID };
  }

  const user = await xClient.getUserByUsername(env.X_USERNAME!);
  logger.info('x.resolved_user', { userId: user.id, username: user.username });
  return { userId: user.id, username: user.username };
}
