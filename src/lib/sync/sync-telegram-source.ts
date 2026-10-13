import type { Source } from '@/db/schema';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { syncStateKey } from '@/lib/sources/repository';
import { processCandidate, type CandidateContext } from '@/lib/sync/process-candidate';
import { findTerminalPostIds, getSyncState, upsertSyncState } from '@/lib/sync/repository';
import { fetchChannelPage, type FetchChannelOptions } from '@/lib/telegram-channel/client';
import { byMessageId, channelPostToPost } from '@/lib/telegram-channel/normalize';
import type { ChannelPagePost } from '@/lib/telegram-channel/parser';
import type { NormalizedPost, SourceSyncSummary } from '@/types';

/**
 * One synchronisation pass over a single public Telegram channel, read from
 * its web page (src/lib/telegram-channel/client.ts).
 *
 * Shaped like an X account's pass rather than a feed's: a channel's message
 * ids only ever grow, so the source keeps a cursor — the last message id it
 * got through, in `sync_state.last_seen_post_id` — and each run reads back
 * from the newest page towards it. Following starts from when the source was
 * added or resumed, by date, as on X. Like the other passes, this never
 * throws: a channel that fails reports why in its summary and the run moves
 * on.
 */

/**
 * Most pages read back towards the cursor in one run. A page is about twenty
 * posts and the sync runs every quarter of an hour, so only a channel posting
 * over a hundred times in that time outruns it.
 */
export const CHANNEL_MAX_PAGES = 5;

export interface TelegramSyncContext extends CandidateContext {
  logger: Logger;
  /** How the channel's page is fetched; injected by tests and the local runner. */
  channelFetch?: FetchChannelOptions;
  /** When to stop taking new posts (epoch ms); unset, there is no limit. */
  deadline?: number;
  now?: () => number;
}

export async function syncTelegramSource(source: Source, context: TelegramSyncContext): Promise<SourceSyncSummary> {
  const { db, env } = context;
  const stateKey = syncStateKey(source);
  const logger = context.logger.child({ source: stateKey, platform: 'telegram', sourceId: source.id });

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
    await upsertSyncState(db, { source: stateKey, workspaceId: source.workspaceId, lastSyncAt: new Date() });

    const cursor = state?.lastSeenPostId ? Number(state.lastSeenPostId) : null;
    const window = await readSinceCursor(source.externalId, cursor, context.channelFetch);
    summary.checked = window.posts.length;
    if (window.overflow) summary.windowOverflow = true;

    logger.info('telegram_channel.fetched', {
      checked: window.posts.length,
      pages: window.pages,
      cursor,
      newestId: window.newestId,
    });

    const posts: NormalizedPost[] = [];
    for (const page of window.posts) {
      const reason = skipReason(page, { includeTextOnly: source.includeTextOnly, includeReposts: env.INCLUDE_REPOSTS });
      const post = channelPostToPost(page);
      if (reason) {
        logger.info('sync.post_skipped', { externalId: post.id, reason });
        summary.skipped += 1;
        continue;
      }
      if (page.unsupported.length > 0) {
        logger.warn('telegram_channel.media_partially_unsupported', {
          externalId: post.id,
          usable: page.media.length,
          problems: page.unsupported,
        });
      }

      // From when the source was added or resumed, as on X: what was there before is backlog.
      if (post.createdAt && post.createdAt < source.followingSince) {
        logger.info('sync.post_skipped', { externalId: post.id, reason: 'posted before the source was followed' });
        summary.skipped += 1;
        continue;
      }
      posts.push(post);
    }

    const terminal = await findTerminalPostIds(
      db,
      posts.map((post) => post.id),
      source.workspaceId,
    );
    const candidates = posts.filter((post) => {
      if (!terminal.has(post.id)) return true;
      logger.info('sync.post_skipped', { externalId: post.id, reason: 'already processed' });
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

    /** Highest message this run reached a decision on; the cursor never passes it. */
    let lastSettled: number | null = null;
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
      if (result.settled) lastSettled = Math.max(lastSettled ?? 0, messageIdOf(post));
    }

    /**
     * As far as this run got, and no further — the same rule as an X
     * account's cursor: never past a post that failed, and past the whole
     * window only when every candidate in it was settled.
     */
    const consumedWholeWindow = !summary.stoppedForTime && batch.length === candidates.length;
    const nextCursor = summary.failed > 0 ? null : consumedWholeWindow ? window.newestId : lastSettled;

    await upsertSyncState(db, {
      source: stateKey,
      workspaceId: source.workspaceId,
      ...(nextCursor !== null && !env.DRY_RUN && nextCursor > (cursor ?? 0) ? { lastSeenPostId: String(nextCursor) } : {}),
      lastSuccessfulSyncAt: new Date(),
      lastError: null,
    });

    logger.info('sync.source_end', { ...summary, lastSeenPostId: nextCursor });
    return summary;
  } catch (error) {
    // Never rethrow: one unreachable channel must not stop the others.
    const message = describeError(error);
    summary.error = message;

    logger.error('sync.source_failed', { error: message });
    await upsertSyncState(db, { source: stateKey, workspaceId: source.workspaceId, lastError: message }).catch(
      () => {},
    );
    return summary;
  }
}

/**
 * Everything after the cursor, oldest first: the newest page, then the pages
 * before it until the cursor is reached. Without a cursor — the first run —
 * only the newest page: a new source starts from its latest posts.
 */
async function readSinceCursor(
  username: string,
  cursor: number | null,
  options: FetchChannelOptions | undefined,
): Promise<{ posts: ChannelPagePost[]; newestId: number | null; pages: number; overflow: boolean }> {
  const seen = new Map<number, ChannelPagePost>();
  let before: number | undefined;
  let pages = 0;
  let overflow = false;

  for (;;) {
    const page = await fetchChannelPage(username, { ...options, before });
    pages += 1;
    // A page of another channel's posts — a rename caught mid-run — is not this one's.
    const own = page.posts.filter((post) => post.channel.toLowerCase() === username);
    for (const post of own) if (cursor === null || post.messageId > cursor) seen.set(post.messageId, post);

    const oldest = own.reduce<number | null>((min, post) => (min === null || post.messageId < min ? post.messageId : min), null);
    if (cursor === null || oldest === null || oldest <= cursor + 1) break;
    if (pages >= CHANNEL_MAX_PAGES) {
      overflow = true;
      break;
    }
    before = oldest;
  }

  const posts = [...seen.values()].sort(byMessageId);
  return { posts, newestId: posts.at(-1)?.messageId ?? null, pages, overflow };
}

/** Why a post is not a candidate at all, or null when it is one. */
function skipReason(post: ChannelPagePost, options: { includeTextOnly: boolean; includeReposts: boolean }): string | null {
  if (post.forwarded && !options.includeReposts) return 'forwarded from another chat';
  // Media that exists but cannot be read is never published as text alone:
  // the post would go out without the very thing that made it a post.
  if (post.media.length === 0 && post.unsupported.length > 0) {
    return `no usable media (${post.unsupported.join('; ')})`;
  }
  if (post.media.length === 0 && (!options.includeTextOnly || post.text === '')) {
    return post.text === '' ? 'no media and no text' : 'no media';
  }
  return null;
}

function messageIdOf(post: NormalizedPost): number {
  return Number(post.id.slice(post.id.lastIndexOf('/') + 1));
}
