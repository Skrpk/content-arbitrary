import { WebsiteError } from '@/lib/errors';
import { decodeText, fetchPublic, type WebsiteFetchOptions } from '@/lib/website/http';

/**
 * One web page's HTML, for its article to be read from — fetched like a
 * sitemap (src/lib/website/http.ts): public addresses only, every redirect
 * checked, a time and a size limit, no cookies, nothing run. HTML only:
 * anything else is not a page this source can read.
 */

/** Largest page read. An article's HTML is rarely past a few hundred kilobytes. */
export const ARTICLE_MAX_BYTES = 3 * 1024 * 1024;

const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);

export interface FetchedPage {
  html: string;
  /** Where it was finally read from, after any redirects. */
  finalUrl: string;
}

export async function fetchArticlePage(url: string, options: WebsiteFetchOptions = {}): Promise<FetchedPage> {
  const fetched = await fetchPublic(url, {
    ...options,
    accept: 'text/html, application/xhtml+xml;q=0.9, */*;q=0.1',
    maxBytes: ARTICLE_MAX_BYTES,
    what: 'page',
  });

  // A server that names no type is judged by what it sent.
  const looksLikeHtml = fetched.contentType === '' && /^\s*(?:<!doctype html|<html|<head|<body)/i.test(new TextDecoder().decode(fetched.bytes.subarray(0, 512)));
  if (!HTML_TYPES.has(fetched.contentType) && !looksLikeHtml) {
    throw new WebsiteError(`The page is not HTML (${fetched.contentType || 'no content type'})`, {
      transient: false,
      code: 'website_not_html',
    });
  }

  return { html: decodeText(fetched.bytes, fetched.charset, metaCharset(fetched.bytes)), finalUrl: fetched.finalUrl };
}

/** The charset a page names in its own `<meta>`, within its first few kilobytes. */
function metaCharset(bytes: Uint8Array): string | null {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  return /<meta[^>]+charset\s*=\s*["']?([A-Za-z0-9._-]+)/i.exec(head)?.[1] ?? null;
}
