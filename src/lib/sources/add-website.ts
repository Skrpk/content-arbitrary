import type { Source } from '@/db/schema';
import type { Database } from '@/lib/db';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { addSource } from '@/lib/sources/repository';
import type { WebsiteFetchOptions } from '@/lib/website/http';
import { readSitemapTree } from '@/lib/website/sitemap';
import { normalizeWebsiteUrl, safeUrlForLog, siteName } from '@/lib/website/url';

/**
 * Add a website as a source, by its sitemap — the one path for /addwebsite
 * and the Sources page alike.
 *
 * The sitemap's address is given, never searched for: no home page, no
 * robots.txt. It is read once first — an index with its sitemaps, within the
 * sync's bounds — so an address that is no sitemap is turned away rather
 * than stored to fail on every sync. No page is fetched, and nothing it lists
 * is sent: the source's first sync records it all as backlog. The source is
 * named by its host; the home page is not fetched for a prettier name.
 */

export type AddWebsiteResult =
  | {
      ok: true;
      source: Source;
      created: boolean;
      host: string;
      kind: 'urlset' | 'index';
      sitemaps: number;
      urls: number;
      /** More than the sync reads in one go: counts are a floor. */
      truncated: boolean;
      warning: string | null;
    }
  | { ok: false; reason: string };

export const NOT_A_SITEMAP = 'This URL does not appear to be a sitemap (<urlset> or <sitemapindex>).';

/** A sitemap past this many pages probably lists the whole site; a news sitemap would be lighter. */
export const LARGE_SITEMAP_URLS = 10_000;

/** Long enough to read an index's sitemaps, short enough for a request. */
const ADD_TIME_BUDGET_MS = 20_000;

export async function addWebsiteSource(
  db: Database,
  input: { url: string; workspaceId: number; websiteFetch?: WebsiteFetchOptions; logger?: Logger; now?: () => number },
): Promise<AddWebsiteResult> {
  const checked = normalizeWebsiteUrl(input.url);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  const now = input.now ?? Date.now;

  let tree;
  try {
    tree = await readSitemapTree(checked.url, { ...input.websiteFetch, deadline: now() + ADD_TIME_BUDGET_MS, now });
  } catch (error) {
    input.logger?.warn('website.add_failed', { ...safeUrlForLog(checked.url), error: describeError(error) });
    return { ok: false, reason: `${NOT_A_SITEMAP} (${error instanceof Error ? error.message : 'unreadable'})` };
  }

  const host = siteName(checked.url);
  const result = await addSource(db, {
    platform: 'website',
    externalId: checked.url,
    username: host,
    workspaceId: input.workspaceId,
  });

  const warning =
    tree.pages.length >= LARGE_SITEMAP_URLS || tree.truncated
      ? 'This sitemap is very large. If the site has a dedicated news or posts sitemap, using that will reduce unnecessary page fetches.'
      : null;

  input.logger?.info('website.source_added', {
    workspaceId: input.workspaceId,
    sourceId: result.source.id,
    siteHost: host,
    created: result.created,
    kind: tree.kind,
    sitemaps: tree.sitemapsRead,
    urls: tree.pages.length,
    truncated: tree.truncated,
  });
  return {
    ok: true,
    source: result.source,
    created: result.created,
    host,
    kind: tree.kind,
    // An index's own sitemaps, not counting the index.
    sitemaps: tree.kind === 'index' ? tree.sitemapsFound - 1 : 1,
    urls: tree.pages.length,
    truncated: tree.truncated,
    warning,
  };
}

/** "Sitemap contains 438 URLs", or "12 sitemaps · 8,421 URLs" for an index — never a promise they are all articles. */
export function describeSitemap(result: Pick<Extract<AddWebsiteResult, { ok: true }>, 'kind' | 'sitemaps' | 'urls' | 'truncated'>): string {
  const urls = `${result.truncated ? 'at least ' : ''}${result.urls.toLocaleString('en-US')} ${result.urls === 1 ? 'URL' : 'URLs'}`;
  if (result.kind === 'urlset') return `Sitemap contains ${urls}`;
  return `${result.sitemaps.toLocaleString('en-US')} ${result.sitemaps === 1 ? 'sitemap' : 'sitemaps'} · ${urls}`;
}
