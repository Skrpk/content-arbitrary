import type { Source } from '@/db/schema';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { syncStateKey } from '@/lib/sources/repository';
import { processCandidate, type CandidateContext } from '@/lib/sync/process-candidate';
import { findTerminalPostIds, getSyncState, upsertSyncState } from '@/lib/sync/repository';
import { profilePosts, type ThreadsCallOptions } from '@/lib/threads/client';
import { NO_THREADS_READER, threadsReaderFor, type ThreadsReadBudget, type ThreadsReading } from '@/lib/threads/reader';
import { threadsPostToPost, threadsSkipReason } from '@/lib/threads/source';
import type { NormalizedPost, SourceSyncSummary } from '@/types';

/**
 * One synchronisation pass over a public Threads account, read through
 * Threads' profile discovery with whichever account reads for this channel
 * (src/lib/threads/reader.ts).
 *
 * One request a pass: the account's posts since the cursor — the newest
 * post's time it got through, in `sync_state.last_seen_post_id` — or, the
 * first time, since the source was followed. A pass costs a request from the
 * reading account's share of the run; when it is spent the source waits,
 * untouched, and goes first next run. Like the other passes, this never
 * throws.
 */

/** Posts one request asks for; more since the cursor than this, and the oldest wait. */
export const THREADS_POSTS_PER_READ = 25;

export interface ThreadsSourceClients {
  reading: ThreadsReading | null;
  budget: ThreadsReadBudget;
  fetchImpl?: ThreadsCallOptions['fetchImpl'];
}

export interface ThreadsSyncContext extends CandidateContext {
  logger: Logger;
  threads: ThreadsSourceClients | null;
  deadline?: number;
  now?: () => number;
}

export async function syncThreadsSource(source: Source, context: ThreadsSyncContext): Promise<SourceSyncSummary> {
  const { db, env } = context;
  const stateKey = syncStateKey(source);
  const logger = context.logger.child({ source: stateKey, platform: 'threads', sourceId: source.id });

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
    const reader = context.threads?.reading ? await threadsReaderFor(db, context.threads.reading, source.workspaceId) : null;
    if (!reader) throw new Error(NO_THREADS_READER);
    if (!context.threads!.budget.take(reader.username)) {
      // Not read, so not marked as synced: it waits longest, and goes first next run.
      logger.info('threads.read_budget_spent', { reader: reader.username });
      return { ...summary, deferred: true };
    }

    const state = await getSyncState(db, stateKey, source.workspaceId);
    await upsertSyncState(db, { source: stateKey, workspaceId: source.workspaceId, lastSyncAt: new Date() });

    const cursor = state?.lastSeenPostId ? new Date(state.lastSeenPostId) : null;
    const since = cursor && !Number.isNaN(cursor.getTime()) && cursor > source.followingSince ? cursor : source.followingSince;
    const fetched = await profilePosts(reader.token, source.externalId, { since, limit: THREADS_POSTS_PER_READ }, { fetchImpl: context.threads!.fetchImpl });
    summary.checked = fetched.length;
    if (fetched.length >= THREADS_POSTS_PER_READ) summary.windowOverflow = true;
    logger.info('threads.fetched', { checked: fetched.length, since: since.toISOString(), reader: reader.username });

    const posts: NormalizedPost[] = [];
    for (const item of fetched) {
      const post = threadsPostToPost(item, source.externalId);
      const reason = threadsSkipReason(item, { includeTextOnly: source.includeTextOnly, includeQuotes: env.INCLUDE_QUOTES });
      if (reason) {
        logger.info('sync.post_skipped', { externalId: post.id, reason });
        summary.skipped += 1;
        continue;
      }
      if (post.createdAt && post.createdAt < source.followingSince) {
        logger.info('sync.post_skipped', { externalId: post.id, reason: 'posted before the source was followed' });
        summary.skipped += 1;
        continue;
      }
      posts.push(post);
    }
    // Oldest first, so the account reads in order.
    posts.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));

    const terminal = await findTerminalPostIds(db, posts.map((post) => post.id), source.workspaceId);
    const candidates = posts.filter((post) => {
      if (!terminal.has(post.id)) return true;
      summary.skipped += 1;
      return false;
    });
    const batch = candidates.slice(0, env.MAX_POSTS_PER_RUN);
    summary.newPosts = batch.length;

    let lastSettled: Date | null = null;
    const now = context.now ?? Date.now;
    for (const [index, post] of batch.entries()) {
      if (context.deadline !== undefined && now() >= context.deadline) {
        summary.stoppedForTime = true;
        summary.newPosts -= batch.length - index;
        logger.warn('sync.time_budget_reached', { unprocessed: batch.length - index });
        break;
      }
      const result = await processCandidate(post, source, context, summary, {
        logger: logger.child({ externalId: post.id }),
        textOnly: source.includeTextOnly,
        spaceOut: index > 0,
      });
      if (result.settled && post.createdAt) lastSettled = post.createdAt;
    }

    // As an X account's cursor: never past a post that failed, past everything read only when all of it was settled.
    const newest = fetched.reduce<Date | null>((max, item) => {
      const at = item.timestamp ? new Date(item.timestamp) : null;
      return at && !Number.isNaN(at.getTime()) && (!max || at > max) ? at : max;
    }, null);
    const consumedAll = !summary.stoppedForTime && batch.length === candidates.length;
    const next = summary.failed > 0 ? null : consumedAll ? newest : lastSettled;

    await upsertSyncState(db, {
      source: stateKey,
      workspaceId: source.workspaceId,
      ...(next && !env.DRY_RUN && (!cursor || next > cursor) ? { lastSeenPostId: next.toISOString() } : {}),
      lastSuccessfulSyncAt: new Date(),
      lastError: null,
    });
    logger.info('sync.source_end', { ...summary, cursor: next?.toISOString() ?? null });
    return summary;
  } catch (error) {
    const message = describeError(error);
    summary.error = message;
    logger.error('sync.source_failed', { error: message });
    await upsertSyncState(db, { source: stateKey, workspaceId: source.workspaceId, lastError: message }).catch(() => {});
    return summary;
  }
}
