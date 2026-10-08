import type { Source } from '@/db/schema';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { fetchFeed, type FetchFeedOptions } from '@/lib/rss/client';
import { entryToPost, oldestFirst } from '@/lib/rss/normalize';
import { parseFeed } from '@/lib/rss/parser';
import { syncStateKey, updateSourceUsername } from '@/lib/sources/repository';
import { processCandidate, type CandidateContext } from '@/lib/sync/process-candidate';
import { findKnownPostIds, getSyncState, recordFeedBacklog, upsertSyncState } from '@/lib/sync/repository';
import type { NormalizedPost, SourceSyncSummary } from '@/types';

/**
 * One synchronisation pass over a single RSS / Atom feed.
 *
 * A feed has no cursor to ask "what is new since": it shows its latest
 * entries every time. So a feed's sync works from identity instead — every
 * entry has a stable id (src/lib/rss/identity.ts), and an entry already in
 * `processed_posts` is never offered again, whatever order the feed lists it
 * in next time.
 *
 * Following from now: the first run after the source is added or resumed
 * records everything already in the feed as backlog, without review, Radar,
 * translation or a message; only entries that appear after that become
 * candidates. Like syncXSource, this never throws — a broken feed reports its
 * error in its summary and the run moves on.
 */

export interface RssSyncContext extends CandidateContext {
  logger: Logger;
  /** How the feed is fetched; injected by tests and the local runner. */
  feedFetch?: FetchFeedOptions;
  /** When to stop taking new posts (epoch ms); unset, there is no limit. */
  deadline?: number;
  now?: () => number;
}

export async function syncRssSource(source: Source, context: RssSyncContext): Promise<SourceSyncSummary> {
  const { db, env } = context;
  const stateKey = syncStateKey(source);
  const logger = context.logger.child({
    platform: 'rss',
    sourceId: source.id,
    workspaceId: source.workspaceId,
    feedHost: safeHost(source.externalId),
  });

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

    logger.info('rss.fetch_started');
    const fetched = await fetchFeed(source.externalId, context.feedFetch);
    logger.info('rss.fetch_done', { bytes: fetched.xml.length, redirectedTo: redirectHost(source.externalId, fetched.finalUrl) });

    let feed;
    try {
      // Relative links resolve against where the feed really is; identity
      // stays tied to the URL the source was stored under.
      feed = parseFeed(fetched.xml, fetched.finalUrl);
    } catch (error) {
      logger.warn('rss.parse_failed', { error: describeError(error) });
      throw error;
    }

    // A feed renamed itself: follow it, as an X handle is followed.
    if (feed.title && feed.title !== source.username) {
      logger.info('source.username_changed', { from: source.username, to: feed.title });
      await updateSourceUsername(db, { id: source.id, username: feed.title });
      summary.username = feed.title;
    }

    const posts = uniqueById(
      feed.entries.map((entry) =>
        entryToPost(entry, { feedUrl: source.externalId, displayName: summary.username }),
      ),
    );
    summary.checked = posts.length;
    logger.info('rss.entries_found', { entries: posts.length });

    /**
     * Added or resumed since the last successful run (or never synced): what
     * the feed holds now is backlog. Recorded, not offered.
     */
    const following =
      !state?.lastSuccessfulSyncAt || state.lastSuccessfulSyncAt.getTime() < source.followingSince.getTime();
    if (following) {
      if (!env.DRY_RUN) {
        await recordFeedBacklog(db, {
          workspaceId: source.workspaceId,
          sourceId: source.id,
          items: posts.map((post) => ({
            xPostId: post.id,
            xPostUrl: post.url,
            xAuthorUsername: post.authorUsername,
            xCreatedAt: post.createdAt,
          })),
        });
      }
      summary.skipped += posts.length;
      logger.info('rss.initialized', { backlog: posts.length, dryRun: env.DRY_RUN });
      await markSynced(context, source, stateKey);
      return summary;
    }

    const known = await findKnownPostIds(
      db,
      posts.map((post) => post.id),
      source.workspaceId,
    );
    const candidates = oldestFirst(posts.filter((post) => !known.has(post.id)));
    summary.skipped += posts.length - candidates.length;

    const batch = candidates.slice(0, env.MAX_POSTS_PER_RUN);
    if (candidates.length > batch.length) {
      // The rest stay unclaimed; still in the feed next run, they are picked up then.
      logger.info('sync.batch_limited', {
        available: candidates.length,
        processing: batch.length,
        maxPostsPerRun: env.MAX_POSTS_PER_RUN,
      });
    }
    summary.newPosts = batch.length;

    const now = context.now ?? Date.now;
    for (const [index, post] of batch.entries()) {
      if (context.deadline !== undefined && now() >= context.deadline) {
        summary.stoppedForTime = true;
        summary.newPosts -= batch.length - index;
        logger.warn('sync.time_budget_reached', { unprocessed: batch.length - index });
        break;
      }

      const result = await processCandidate(post, source, context, summary, {
        logger: logger.child({ xPostId: post.id }),
        // Every feed entry is text; the X-only "posts without media" switch has no say.
        textOnly: true,
        spaceOut: index > 0,
      });
      if (result.kind === 'skipped') logger.info('rss.entry_skipped', { xPostId: post.id });
    }

    await markSynced(context, source, stateKey);
    logger.info('sync.source_end', { ...summary });
    return summary;
  } catch (error) {
    // Never rethrow: one broken feed must not stop the others, or X.
    const message = describeError(error);
    summary.error = message;

    logger.error('rss.source_failed', { error: message });
    await upsertSyncState(db, { source: stateKey, workspaceId: source.workspaceId, lastError: message }).catch(
      () => {},
    );
    return summary;
  }
}

/**
 * A good run. Not recorded on a dry run: the first real run must still find
 * the feed unfollowed and record its backlog, which a dry run does not write.
 */
async function markSynced(context: RssSyncContext, source: Source, stateKey: string): Promise<void> {
  await upsertSyncState(context.db, {
    source: stateKey,
    workspaceId: source.workspaceId,
    ...(context.env.DRY_RUN ? {} : { lastSuccessfulSyncAt: new Date() }),
    lastError: null,
  });
}

/** A feed listing the same entry twice offers it once. */
function uniqueById(posts: NormalizedPost[]): NormalizedPost[] {
  const seen = new Set<string>();
  return posts.filter((post) => {
    if (seen.has(post.id)) return false;
    seen.add(post.id);
    return true;
  });
}

/** The host alone, for logs — never the whole URL. */
function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function redirectHost(from: string, to: string): string | undefined {
  return from === to ? undefined : (safeHost(to) ?? undefined);
}
