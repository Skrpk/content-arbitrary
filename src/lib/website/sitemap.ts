import { gunzipSync } from 'node:zlib';
import { describeError, WebsiteError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { decodeText, fetchPublic, type WebsiteFetchOptions } from '@/lib/website/http';
import { parseSitemap, type ParsedSitemap } from '@/lib/website/sitemap-parser';
import { normalizeWebsiteUrl, safeUrlForLog, sameSite, webItemId } from '@/lib/website/url';

/**
 * A website's sitemap tree, read within bounds: the sitemap the source was
 * added with and, when it is an index, the sitemaps it names — recursively,
 * a few levels deep at most, each once, and only on the same site. What
 * comes out is every page address they list, normalised, each once, with
 * its id.
 *
 * Sitemaps only: the pages themselves are never fetched here.
 */

/** How deep an index may lead: the sitemap given, an index's sitemaps, and theirs. */
export const MAX_SITEMAP_DEPTH = 3;
/** Sitemap files read in one sync of one source. A site with more is read newest first, up to this. */
export const WEBSITE_MAX_SITEMAPS_PER_SYNC = 25;
/** Page addresses taken from one source's sitemaps in one sync — the protocol's own limit for one file. */
export const WEBSITE_MAX_URLS_PER_SYNC = 50_000;
/** Largest sitemap download, compressed or not. */
export const SITEMAP_MAX_BYTES = 10 * 1024 * 1024;
/** Largest sitemap once decompressed: a guard against a small file that inflates enormously. */
export const SITEMAP_MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;

const SITEMAP_ACCEPT = 'application/xml, text/xml;q=0.9, application/x-gzip;q=0.8, application/gzip;q=0.8, */*;q=0.5';

export interface FetchedSitemap {
  sitemap: ParsedSitemap;
  finalUrl: string;
  bytes: number;
  compressed: boolean;
}

/** One sitemap file, fetched, decompressed when it is gzip, and parsed. */
export async function fetchSitemap(url: string, options: WebsiteFetchOptions = {}): Promise<FetchedSitemap> {
  const fetched = await fetchPublic(url, { ...options, accept: SITEMAP_ACCEPT, maxBytes: SITEMAP_MAX_BYTES, what: 'sitemap' });
  const compressed = fetched.bytes[0] === 0x1f && fetched.bytes[1] === 0x8b;
  const bytes = compressed ? gunzip(fetched.bytes) : fetched.bytes;
  if (bytes.byteLength > SITEMAP_MAX_UNCOMPRESSED_BYTES) throw tooLarge();

  const xml = decodeText(bytes, declaredEncoding(bytes), fetched.charset);
  return { sitemap: parseSitemap(xml), finalUrl: fetched.finalUrl, bytes: bytes.byteLength, compressed };
}

/** Inflated, but never past SITEMAP_MAX_UNCOMPRESSED_BYTES: zlib stops there itself. */
function gunzip(bytes: Uint8Array): Uint8Array {
  try {
    return gunzipSync(bytes, { maxOutputLength: SITEMAP_MAX_UNCOMPRESSED_BYTES });
  } catch (error) {
    if (error instanceof RangeError || (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw tooLarge();
    throw new WebsiteError(`Not a sitemap: the gzip file is broken (${describeError(error)}).`, {
      transient: false,
      code: 'website_not_sitemap',
    });
  }
}

function tooLarge(): WebsiteError {
  return new WebsiteError(`The sitemap is larger than ${SITEMAP_MAX_UNCOMPRESSED_BYTES / 1024 / 1024} MB uncompressed`, {
    transient: false,
    code: 'website_too_large',
  });
}

/** The encoding the XML declaration names, if any. */
function declaredEncoding(bytes: Uint8Array): string | null {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
  return /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head)?.[1] ?? null;
}

/** A page a sitemap lists. */
export interface DiscoveredPage {
  /** Its normalised address — its identity. */
  url: string;
  /** `web:<hash>` of that address. */
  id: string;
  lastmod: Date | null;
  published: Date | null;
  /** The sitemap that listed it first. */
  sitemapUrl: string;
}

export interface SitemapTree {
  /** What the sitemap the source was added with is. */
  kind: ParsedSitemap['kind'];
  /** Every page, each once, in the order the sitemaps listed them. */
  pages: DiscoveredPage[];
  /** Sitemap files read, the first included. */
  sitemapsRead: number;
  /** Sitemap files the tree names, read or not. */
  sitemapsFound: number;
  /** Child sitemaps that could not be read this time, with why. */
  failures: { url: string; error: unknown }[];
  /** Addresses left out: on another site, or not an address at all. */
  rejected: number;
  /** Indexes nested deeper than MAX_SITEMAP_DEPTH, left unread. */
  tooDeep: number;
  /** Stopped at a limit — sitemaps, pages or time — with sitemaps or pages still unread. */
  truncated: boolean;
}

export interface ReadTreeOptions extends WebsiteFetchOptions {
  logger?: Logger;
  /** When to stop reading sitemaps (epoch ms); unset, there is no limit. */
  deadline?: number;
  now?: () => number;
  maxSitemaps?: number;
  maxUrls?: number;
}

/**
 * Read the tree from its root, breadth first. The root must be read — a
 * failure there throws. A child sitemap that fails is noted in `failures` and
 * the rest are read; whether that is good enough is the caller's to say.
 *
 * An index's sitemaps are read newest `<lastmod>` first, so when a site has
 * more than a sync reads, the ones read are those that change.
 */
export async function readSitemapTree(rootUrl: string, options: ReadTreeOptions = {}): Promise<SitemapTree> {
  const maxSitemaps = options.maxSitemaps ?? WEBSITE_MAX_SITEMAPS_PER_SYNC;
  const maxUrls = options.maxUrls ?? WEBSITE_MAX_URLS_PER_SYNC;
  const now = options.now ?? Date.now;
  const logger = options.logger;

  const tree: SitemapTree = {
    kind: 'urlset',
    pages: [],
    sitemapsRead: 0,
    sitemapsFound: 1,
    failures: [],
    rejected: 0,
    tooDeep: 0,
    truncated: false,
  };
  const seenPages = new Set<string>();
  const seenSitemaps = new Set<string>([rootUrl]);
  const queue: { url: string; depth: number }[] = [{ url: rootUrl, depth: 1 }];

  while (queue.length > 0) {
    if (tree.sitemapsRead >= maxSitemaps || tree.pages.length >= maxUrls) {
      tree.truncated = true;
      break;
    }
    if (options.deadline !== undefined && now() >= options.deadline) {
      tree.truncated = true;
      break;
    }

    const { url, depth } = queue.shift()!;
    const isRoot = tree.sitemapsRead === 0 && tree.failures.length === 0 && url === rootUrl;
    logger?.info('website.sitemap_fetch_started', { ...safeUrlForLog(url), depth });

    let fetched: FetchedSitemap;
    try {
      fetched = await fetchSitemap(url, options);
    } catch (error) {
      if (isRoot) throw error;
      logger?.warn('website.sitemap_failed', { ...safeUrlForLog(url), depth, error: describeError(error) });
      tree.failures.push({ url, error });
      continue;
    }
    tree.sitemapsRead += 1;
    if (isRoot) tree.kind = fetched.sitemap.kind;
    logger?.info('website.sitemap_fetch_done', {
      ...safeUrlForLog(url),
      depth,
      kind: fetched.sitemap.kind,
      bytes: fetched.bytes,
      compressed: fetched.compressed,
      entries: fetched.sitemap.kind === 'urlset' ? fetched.sitemap.urls.length : fetched.sitemap.sitemaps.length,
    });

    if (fetched.sitemap.kind === 'index') {
      for (const child of newestFirst(fetched.sitemap.sitemaps)) {
        const checked = normalizeWebsiteUrl(child.loc);
        if (!checked.ok || !sameSite(checked.url, rootUrl)) {
          tree.rejected += 1;
          continue;
        }
        // A sitemap named twice, or naming one already read — A → B → A — is read once.
        if (seenSitemaps.has(checked.url)) continue;
        seenSitemaps.add(checked.url);
        tree.sitemapsFound += 1;
        if (depth + 1 > MAX_SITEMAP_DEPTH) {
          tree.tooDeep += 1;
          continue;
        }
        queue.push({ url: checked.url, depth: depth + 1 });
      }
      continue;
    }

    for (const entry of fetched.sitemap.urls) {
      if (tree.pages.length >= maxUrls) {
        tree.truncated = true;
        break;
      }
      const checked = normalizeWebsiteUrl(entry.loc);
      if (!checked.ok || !sameSite(checked.url, rootUrl)) {
        tree.rejected += 1;
        continue;
      }
      const id = webItemId(checked.url);
      if (seenPages.has(id)) continue;
      seenPages.add(id);
      tree.pages.push({ url: checked.url, id, lastmod: entry.lastmod, published: entry.published, sitemapUrl: url });
    }
  }

  logger?.info('website.sitemaps_found', {
    read: tree.sitemapsRead,
    found: tree.sitemapsFound,
    failed: tree.failures.length,
    tooDeep: tree.tooDeep,
    truncated: tree.truncated,
  });
  logger?.info('website.urls_found', { pages: tree.pages.length, rejected: tree.rejected });
  return tree;
}

/** Newest `<lastmod>` first; those without one after, in the order given. */
function newestFirst<T extends { lastmod: Date | null }>(entries: T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const at = a.entry.lastmod?.getTime();
      const bt = b.entry.lastmod?.getTime();
      if (at !== undefined && bt !== undefined && at !== bt) return bt - at;
      if (at !== undefined && bt === undefined) return -1;
      if (at === undefined && bt !== undefined) return 1;
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
}
