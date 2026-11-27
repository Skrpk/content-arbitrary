import { parse } from 'node-html-parser';
import type { Logger } from '@/lib/logger';
import type { FetchFeedOptions } from '@/lib/rss/client';
import { resolveRssSource } from '@/lib/sources/add-rss';
import { LARGE_SITEMAP_URLS, resolveWebsiteSource } from '@/lib/sources/add-website';
import type { ResolvedSource } from '@/lib/sources/resolve';
import { decodeText, fetchPublic, type WebsiteFetchOptions } from '@/lib/website/http';

/**
 * How Zmistik can follow a website it only knows the address of (§17): its
 * RSS or Atom feed when it has one — announced on its home page, or at a
 * usual path — and otherwise a news sitemap, then any sitemap small enough
 * to read. Null when it has neither.
 *
 * Every fetch goes through the same guards as a feed's and a sitemap's: http(s)
 * only, no private or local addresses, bounded size and time.
 */

export interface SiteFeedOptions {
  fetchImpl?: typeof fetch;
  lookup?: WebsiteFetchOptions['lookup'];
  /** Each fetch's timeout. */
  timeoutMs?: number;
  /** Give up on this site past this moment (ms since epoch). */
  deadline?: number;
  now?: () => number;
  logger?: Logger;
}

export type SiteFeed = { kind: 'rss' | 'news_sitemap' | 'sitemap'; source: ResolvedSource };

const FEED_PATHS = ['/feed', '/rss', '/feed.xml', '/rss.xml', '/atom.xml', '/feed/'];
const SITEMAP_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml'];
const FEED_TYPES = /^application\/(rss|atom)\+xml$/i;

export async function discoverSiteFeed(homepage: string, options: SiteFeedOptions = {}): Promise<SiteFeed | null> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 6_000;
  const late = () => options.deadline !== undefined && now() >= options.deadline;
  const web: WebsiteFetchOptions = { fetchImpl: options.fetchImpl, lookup: options.lookup, timeoutMs };
  const feedFetch: FetchFeedOptions = { fetchImpl: options.fetchImpl, lookup: options.lookup, timeoutMs };

  let origin: string;
  try {
    origin = new URL(homepage).origin;
  } catch {
    return null;
  }

  // 1. A feed: those the home page announces on the site's own host, the usual paths there, then
  // feeds on other hosts — where a site that sends visitors to a regional edition announces them.
  const host = new URL(origin).hostname;
  const announced = await announcedFeeds(homepage, web);
  const ownHost = announced.filter((url) => new URL(url).hostname === host);
  const elsewhere = announced.filter((url) => new URL(url).hostname !== host);
  const tried = new Set<string>();
  for (const url of [...ownHost, ...FEED_PATHS.map((path) => `${origin}${path}`), ...elsewhere]) {
    if (late()) return null;
    if (tried.has(url)) continue;
    tried.add(url);
    const feed = await resolveRssSource({ url, feedFetch });
    if (feed.ok && feed.entries > 0) return { kind: 'rss', source: feed.source };
  }

  // 2. A news sitemap from robots.txt; 3. any sitemap, but not one that lists the whole site.
  const fromRobots = await robotsSitemaps(origin, web);
  const news = fromRobots.filter((url) => /news/i.test(url));
  const others = [...fromRobots.filter((url) => !/news/i.test(url)), ...SITEMAP_PATHS.map((path) => `${origin}${path}`)];
  for (const [url, isNews] of [...news.map((url) => [url, true] as const), ...[...new Set(others)].map((url) => [url, false] as const)]) {
    if (late()) return null;
    const site = await resolveWebsiteSource({ url, websiteFetch: web, now, budgetMs: 10_000 });
    if (!site.ok || site.tree.pages.length === 0) continue;
    if (!isNews && (site.tree.truncated || site.tree.pages.length >= LARGE_SITEMAP_URLS)) continue;
    return { kind: isNews ? 'news_sitemap' : 'sitemap', source: site.source };
  }
  return null;
}

/** `<link rel="alternate" type="application/rss+xml" href="…">` on the home page, as absolute URLs. */
async function announcedFeeds(homepage: string, web: WebsiteFetchOptions): Promise<string[]> {
  try {
    const page = await fetchPublic(homepage, { ...web, accept: 'text/html', maxBytes: 2 * 1024 * 1024, what: 'home page' });
    const root = parse(decodeText(page.bytes, page.charset));
    const urls: string[] = [];
    for (const link of root.querySelectorAll('link[rel~="alternate"][href]')) {
      if (!FEED_TYPES.test(link.getAttribute('type') ?? '')) continue;
      try {
        urls.push(new URL(link.getAttribute('href')!, page.finalUrl).toString());
      } catch {
        // An href that is no URL: skipped.
      }
    }
    return urls.slice(0, 5);
  } catch {
    return [];
  }
}

/** The `Sitemap:` lines of the site's robots.txt. */
async function robotsSitemaps(origin: string, web: WebsiteFetchOptions): Promise<string[]> {
  try {
    const robots = await fetchPublic(`${origin}/robots.txt`, { ...web, accept: 'text/plain', maxBytes: 512 * 1024, what: 'robots.txt' });
    return decodeText(robots.bytes, robots.charset)
      .split(/\r?\n/)
      .map((line) => /^\s*sitemap\s*:\s*(\S+)/i.exec(line)?.[1])
      .filter((url): url is string => Boolean(url && /^https?:\/\//i.test(url)))
      .slice(0, 10);
  } catch {
    return [];
  }
}
