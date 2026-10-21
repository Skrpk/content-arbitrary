import { createHash } from 'node:crypto';
import { blockedHostReason } from '@/lib/rss/url';
import { WEB_ITEM_ID_PREFIX } from '@/lib/sources/display';

/**
 * Addresses on a website source: the sitemap a reviewer gives, the sitemaps
 * it names and the pages they list.
 *
 * Every one is something our server will fetch because a web page told it
 * to, so each is checked here for its shape — and, before each fetch, for
 * where it really points (src/lib/website/http.ts). A sitemap may only lead
 * to its own site: its child sitemaps and its pages must be on the same site
 * as the sitemap itself, so a sitemap cannot turn the server into a fetcher
 * of arbitrary addresses.
 */

export type WebsiteUrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/**
 * The canonical form of an address, or why it cannot be one.
 *
 * Conservative on purpose: the URL parser lower-cases the scheme and host and
 * drops a default port, and the fragment goes; the path and the query stay
 * exactly as given — some sites tell their pages apart by the query alone.
 */
export function normalizeWebsiteUrl(input: string): WebsiteUrlCheck {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, reason: 'No URL given.' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'That is not a URL.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Only http and https addresses are supported.' };
  }
  if (url.username || url.password) return { ok: false, reason: 'An address may not carry a username or password.' };

  const blocked = blockedHostReason(url.hostname);
  if (blocked) return { ok: false, reason: blocked };

  url.hash = '';
  return { ok: true, url: url.toString() };
}

/**
 * A page's id in `processed_posts.external_id`: `web:` and the SHA-256 of its
 * normalised address. The address alone, not the sitemap's, so a page listed
 * in two sitemaps — or by two sources of one channel — is one candidate; and
 * fixed once the page is found, whatever canonical address it later names.
 */
export function webItemId(normalizedUrl: string): string {
  return `${WEB_ITEM_ID_PREFIX}${createHash('sha256').update(normalizedUrl).digest('hex')}`;
}

/** A website source's name: its host, without `www.`. */
export function siteName(url: string): string {
  return new URL(url).hostname.replace(/^www\./, '');
}

/**
 * Whether two addresses are on the same site: the same host, or one a
 * subdomain of the other once `www.` is set aside — `www.example.com`,
 * `example.com` and `news.example.com` are one site; `example.com.evil.net`
 * is not. Deliberately simple: no public-suffix list, so a site spread over
 * unrelated domains is not followed across them.
 */
export function sameSite(a: string | URL, b: string | URL): boolean {
  const hostA = baseHost(typeof a === 'string' ? new URL(a) : a);
  const hostB = baseHost(typeof b === 'string' ? new URL(b) : b);
  if (!hostA || !hostB) return false;
  return hostA === hostB || hostA.endsWith(`.${hostB}`) || hostB.endsWith(`.${hostA}`);
}

function baseHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, '');
}

/** An address for a log: host and a short hash of the rest — never the query, which may hold a token. */
export function safeUrlForLog(url: string): { host: string | null; pathHash: string | null } {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      pathHash: createHash('sha256').update(`${parsed.pathname}${parsed.search}`).digest('hex').slice(0, 12),
    };
  } catch {
    return { host: null, pathHash: null };
  }
}
