import type { Source } from '@/db/schema';
import { describeError, isTransient } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { syncStateKey } from '@/lib/sources/repository';
import { processCandidate, type CandidateContext } from '@/lib/sync/process-candidate';
import {
  findKnownPostIds,
  getSyncState,
  recordFeedBacklog,
  recordPageFailure,
  recordSkippedPage,
  RSS_BACKLOG_REASON,
  upsertSyncState,
  WEBSITE_PAGE_REASON_PREFIX,
} from '@/lib/sync/repository';
import { fetchArticlePage } from '@/lib/website/article-client';
import { extractArticle } from '@/lib/website/article-extractor';
import type { WebsiteFetchOptions } from '@/lib/website/http';
import { articleToPost } from '@/lib/website/normalize';
import { readSitemapTree, type DiscoveredPage } from '@/lib/website/sitemap';
import { safeUrlForLog } from '@/lib/website/url';
import type { SourceSyncSummary } from '@/types';

/**
 * One synchronisation pass over a website, through its sitemap.
 *
 * The sitemap is the cheap way to learn what is new: it is read every run —
 * bounded, see src/lib/website/sitemap.ts — and a page is new by identity,
 * its address, as a feed's entry is (src/lib/sync/sync-rss-source.ts). Only
 * a new page is fetched, and only its own HTML; its article is read with
 * Readability and handed on as any other candidate, to Radar, translation,
 * stories and review. `<lastmod>` never makes a known page new again.
 *
 * Following from now: the first run after the source is added or resumed
 * records every page the sitemaps list as backlog — no page fetched, no
 * Radar, no review — and only pages that appear after that are candidates.
 *
 * Bounded per run: the pages fetched, the candidates handed on
 * (MAX_POSTS_PER_RUN) and the run's time. What is left stays new — nothing is
 * marked known that was not looked at — and is taken on a later run, oldest
 * first. Like every pass this never throws: a broken site says why in its
 * summary, and the other sources go on.
 */

/** Pages fetched in one run of one source, articles or not. */
export const WEBSITE_MAX_PAGE_FETCHES_PER_SYNC = 15;
/**
 * A page this much older than the moment the source was followed already
 * existed then — whatever its address — and is backlog, not news: a guard
 * for sitemaps the first run did not reach.
 */
export const WEBSITE_BACKLOG_MARGIN_MS = 24 * 60 * 60 * 1000;

export interface WebsiteSyncContext extends CandidateContext {
  logger: Logger;
  /** How sitemaps and pages are fetched; injected by tests and the local runner. */
  websiteFetch?: WebsiteFetchOptions;
  /** When to stop taking new posts (epoch ms); unset, there is no limit. */
  deadline?: number;
  now?: () => number;
}

export async function syncWebsiteSource(source: Source, context: WebsiteSyncContext): Promise<SourceSyncSummary> {
  const { db, env } = context;
  const stateKey = syncStateKey(source);
  const now = context.now ?? Date.now;
  const logger = context.logger.child({
    platform: 'website',
    sourceId: source.id,
    workspaceId: source.workspaceId,
    siteHost: safeUrlForLog(source.externalId).host,
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

    const tree = await readSitemapTree(source.externalId, {
      ...context.websiteFetch,
      logger,
      deadline: context.deadline,
      now,
    });
    summary.checked = tree.pages.length;

    const following =
      !state?.lastSuccessfulSyncAt || state.lastSuccessfulSyncAt.getTime() < source.followingSince.getTime();
    if (following) {
      // Everything the site has now is backlog — so all of it must have been seen.
      // A sitemap that failed would leave its pages to look new next run: try the whole again.
      if (tree.failures.length > 0) {
        throw new Error(`${tree.failures.length} of the site's sitemaps could not be read; following starts once they can`);
      }
      if (context.deadline !== undefined && now() >= context.deadline) {
        summary.stoppedForTime = true;
        logger.warn('sync.time_budget_reached', { stage: 'backlog' });
        return summary;
      }
      if (!env.DRY_RUN) {
        await recordFeedBacklog(db, {
          workspaceId: source.workspaceId,
          sourceId: source.id,
          items: tree.pages.map((page) => backlogRow(page, source)),
        });
      }
      summary.skipped += tree.pages.length;
      logger.info('website.initialized', { backlog: tree.pages.length, truncated: tree.truncated, dryRun: env.DRY_RUN });
      await markSynced(context, source, stateKey);
      return summary;
    }

    const known = await findKnownPostIds(
      db,
      tree.pages.map((page) => page.id),
      source.workspaceId,
    );
    const fresh = oldestFirst(tree.pages.filter((page) => !known.has(page.id)));
    summary.skipped += tree.pages.length - fresh.length;
    logger.info('website.new_urls_found', { pages: tree.pages.length, fresh: fresh.length });

    const backlogBefore = source.followingSince.getTime() - WEBSITE_BACKLOG_MARGIN_MS;
    let fetches = 0;
    let candidates = 0;

    for (const [index, page] of fresh.entries()) {
      if (context.deadline !== undefined && now() >= context.deadline) {
        summary.stoppedForTime = true;
        logger.warn('sync.time_budget_reached', { unprocessed: fresh.length - index });
        break;
      }

      // The sitemap says the page is older than the source: backlog, without a fetch.
      const listedAt = page.published ?? page.lastmod;
      if (listedAt && listedAt.getTime() < backlogBefore) {
        if (!env.DRY_RUN) await recordSkippedPage(db, { ...backlogRow(page, source), reason: RSS_BACKLOG_REASON });
        summary.skipped += 1;
        continue;
      }

      if (fetches >= WEBSITE_MAX_PAGE_FETCHES_PER_SYNC || candidates >= env.MAX_POSTS_PER_RUN) {
        // The rest stay new; still in the sitemap next run, they are taken then.
        logger.info('sync.batch_limited', {
          available: fresh.length,
          fetched: fetches,
          candidates,
          maxPostsPerRun: env.MAX_POSTS_PER_RUN,
          maxPageFetches: WEBSITE_MAX_PAGE_FETCHES_PER_SYNC,
        });
        break;
      }
      fetches += 1;

      const pageLogger = logger.child({ externalId: page.id, ...safeUrlForLog(page.url) });
      const outcome = await readPage(page, source, context, pageLogger);
      if (outcome.kind === 'skip') {
        if (!env.DRY_RUN) await recordSkippedPage(db, { ...backlogRow(page, source), reason: outcome.reason });
        summary.skipped += 1;
        continue;
      }
      if (outcome.kind === 'failed') {
        if (!env.DRY_RUN) {
          const result = await recordPageFailure(db, {
            ...backlogRow(page, source),
            error: outcome.error,
            maxRetryAttempts: env.MAX_RETRY_ATTEMPTS,
          });
          if (result === 'gave-up') pageLogger.warn('website.article_given_up', { attempts: env.MAX_RETRY_ATTEMPTS });
        }
        summary.failed += 1;
        continue;
      }

      const post = outcome.post;
      // An article older than the source, by its own date: backlog too, for Radar is not spent on it.
      if (post.createdAt && post.createdAt.getTime() < backlogBefore) {
        if (!env.DRY_RUN) await recordSkippedPage(db, { ...backlogRow(page, source), reason: RSS_BACKLOG_REASON });
        pageLogger.info('website.article_older_than_source', { publishedAt: post.createdAt });
        summary.skipped += 1;
        continue;
      }

      summary.newPosts += 1;
      await processCandidate(post, source, context, summary, {
        logger: pageLogger,
        // An article has no media of its own: it goes out as its text and its link.
        textOnly: true,
        spaceOut: candidates > 0,
      });
      candidates += 1;
    }

    if (tree.failures.length > 0) {
      // Some of the site's sitemaps could not be read: what they list waits for a run that can.
      logger.warn('website.sitemaps_unread', { failed: tree.failures.length });
    }
    await markSynced(context, source, stateKey);
    logger.info('sync.source_end', { ...summary });
    return summary;
  } catch (error) {
    // Never rethrow: one broken site must not stop the others, or X.
    const message = describeError(error);
    summary.error = message;
    logger.error('website.source_failed', { error: message });
    await upsertSyncState(db, { source: stateKey, workspaceId: source.workspaceId, lastError: message }).catch(() => {});
    return summary;
  }
}

type PageOutcome =
  | { kind: 'article'; post: ReturnType<typeof articleToPost> }
  | { kind: 'skip'; reason: string }
  | { kind: 'failed'; error: string };

/** One new page: fetched, its article read. A page that never will be one is a skip; a failure that may pass, a retry. */
async function readPage(page: DiscoveredPage, source: Source, context: WebsiteSyncContext, logger: Logger): Promise<PageOutcome> {
  logger.info('website.article_fetch_started');
  let fetched;
  try {
    fetched = await fetchArticlePage(page.url, context.websiteFetch);
  } catch (error) {
    const message = describeError(error);
    if (isTransient(error)) {
      logger.warn('website.article_failed', { error: message, transient: true });
      return { kind: 'failed', error: message };
    }
    logger.info('website.article_failed', { error: message, transient: false });
    return { kind: 'skip', reason: `${WEBSITE_PAGE_REASON_PREFIX}${message}` };
  }

  let extraction;
  try {
    extraction = extractArticle(fetched.html, fetched.finalUrl);
  } catch (error) {
    // A page jsdom or Readability chokes on will choke them again.
    const message = describeError(error);
    logger.warn('website.article_not_readable', { error: message });
    return { kind: 'skip', reason: `${WEBSITE_PAGE_REASON_PREFIX}could not be parsed: ${message}` };
  }
  if (!extraction.ok) {
    logger.info('website.article_not_readable', { reason: extraction.reason });
    return { kind: 'skip', reason: `${WEBSITE_PAGE_REASON_PREFIX}not an article: ${extraction.reason}` };
  }

  const post = articleToPost(extraction.article, { ...page, finalUrl: fetched.finalUrl }, source);
  logger.info('website.article_extracted', {
    length: extraction.article.text.length,
    declaredArticle: extraction.article.declaredArticle,
    publishedAt: post.createdAt,
    canonical: extraction.article.canonicalUrl !== null,
  });
  return { kind: 'article', post };
}

/** A page as a row of its own, before it has any text: its address, its site, its sitemap date. */
function backlogRow(page: DiscoveredPage, source: Source) {
  return {
    workspaceId: source.workspaceId,
    sourceId: source.id,
    externalId: page.id,
    xPostUrl: page.url,
    xAuthorUsername: source.username,
    xCreatedAt: page.published ?? page.lastmod,
  };
}

/**
 * Oldest first, by the sitemap's dates — a news sitemap's publication date,
 * else `<lastmod>` — so the channel reads in order; pages without a date come
 * after, in the order the sitemaps list them. No date is guessed.
 */
function oldestFirst(pages: DiscoveredPage[]): DiscoveredPage[] {
  return pages
    .map((page, index) => ({ page, index, at: (page.published ?? page.lastmod)?.getTime() }))
    .sort((a, b) => {
      if (a.at !== undefined && b.at !== undefined && a.at !== b.at) return a.at - b.at;
      if (a.at !== undefined && b.at === undefined) return -1;
      if (a.at === undefined && b.at !== undefined) return 1;
      return a.index - b.index;
    })
    .map(({ page }) => page);
}

/**
 * A good run. Not recorded on a dry run: the first real run must still find
 * the site unfollowed and record its backlog, which a dry run does not write.
 */
async function markSynced(context: WebsiteSyncContext, source: Source, stateKey: string): Promise<void> {
  await upsertSyncState(context.db, {
    source: stateKey,
    workspaceId: source.workspaceId,
    ...(context.env.DRY_RUN ? {} : { lastSuccessfulSyncAt: new Date() }),
    lastError: null,
  });
}
