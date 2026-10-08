import type { Source } from '@/db/schema';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { syncStateKey, updateSourceUsername } from '@/lib/sources/repository';
import { processCandidate, type CandidateContext } from '@/lib/sync/process-candidate';
import { findTerminalPostIds, getSyncState, upsertSyncState } from '@/lib/sync/repository';
import type { XClient } from '@/lib/x/client';
import { compareSnowflake, getNewPosts } from '@/lib/x/get-new-posts';
import type { SourceSyncSummary } from '@/types';

/**
 * One synchronisation pass over a single X account.
 *
 * Each source keeps its own `sync_state` cursor, keyed `x:<userId>`, so adding
 * or removing accounts never disturbs the others' positions. This function
 * never throws: a source that fails reports the reason in its summary so the
 * orchestrator can carry on with the next one.
 */

export interface SourceSyncContext extends CandidateContext {
  logger: Logger;
  xClient: XClient;
  /** When to stop taking new posts (epoch ms); unset, there is no limit. */
  deadline?: number;
  now?: () => number;
}

export async function syncXSource(
  source: Source,
  context: SourceSyncContext,
): Promise<SourceSyncSummary> {
  const { db, env, xClient } = context;
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

      const result = await processCandidate(post, source, context, summary, {
        logger: logger.child({ xPostId: post.id }),
        textOnly: source.includeTextOnly,
        spaceOut: index > 0,
      });
      if (result.settled) settle(post.id);
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
