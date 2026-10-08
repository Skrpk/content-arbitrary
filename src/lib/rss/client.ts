import { FeedError } from '@/lib/errors';
import { SITE_NAME, SITE_URL } from '@/lib/site';
import { assertFetchable, lookupHost, type HostLookup, UnsafeFeedUrlError } from '@/lib/rss/url';

/**
 * Fetches a feed's XML — and nothing else: never the articles it links to.
 *
 * Every hop is checked before it is requested, so a public feed cannot
 * redirect the server to a private address. The body is read up to a fixed
 * size and no further, so one runaway feed cannot exhaust the function.
 *
 * TODO(rss-conditional-fetch): send If-None-Match / If-Modified-Since from
 * the last fetch and treat 304 as "nothing new".
 */

/** Largest feed accepted, in bytes. Real feeds are tens of kilobytes. */
export const FEED_MAX_BYTES = 5 * 1024 * 1024;
export const FEED_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 5;

const USER_AGENT = `Mozilla/5.0 (compatible; ${SITE_NAME.replace(/\s+/g, '')}/1.0; +${SITE_URL})`;

export interface FetchFeedOptions {
  fetchImpl?: typeof fetch;
  lookup?: HostLookup;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface FetchedFeed {
  xml: string;
  /** Where the feed was finally read from, after any redirects. */
  finalUrl: string;
}

export async function fetchFeed(feedUrl: string, options: FetchFeedOptions = {}): Promise<FetchedFeed> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookup = options.lookup ?? lookupHost;
  const maxBytes = options.maxBytes ?? FEED_MAX_BYTES;
  const signal = AbortSignal.timeout(options.timeoutMs ?? FEED_TIMEOUT_MS);

  let url = parseUrl(feedUrl);

  for (let hop = 0; ; hop += 1) {
    await assertFetchable(url, lookup);

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        redirect: 'manual',
        signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5',
        },
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new FeedError(`Feed did not answer within ${Math.round((options.timeoutMs ?? FEED_TIMEOUT_MS) / 1000)} s`, {
          transient: true,
          code: 'feed_timeout',
          cause: error,
        });
      }
      throw new FeedError(`Could not reach the feed: ${error instanceof Error ? error.message : String(error)}`, {
        transient: true,
        code: 'feed_network',
        cause: error,
      });
    }

    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) {
        throw new FeedError(`Feed redirected (${response.status}) without saying where`, {
          transient: false,
          code: 'feed_redirect',
          status: response.status,
        });
      }
      if (hop >= MAX_REDIRECTS) {
        throw new FeedError('Feed redirected too many times', { transient: false, code: 'feed_redirect' });
      }
      url = parseUrl(new URL(location, url).toString());
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw statusError(response);
    }

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw tooLarge(maxBytes);
    }

    return { xml: await readCapped(response, maxBytes), finalUrl: url.toString() };
  }
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new UnsafeFeedUrlError('That is not a URL.');
  }
}

function statusError(response: Response): FeedError {
  const status = response.status;
  if (status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    return new FeedError('Feed is rate limiting us (429)', {
      transient: true,
      code: 'feed_rate_limited',
      status,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
    });
  }
  if (status >= 500) {
    return new FeedError(`Feed server error (${status})`, { transient: true, code: 'feed_server_error', status });
  }
  if (status === 404 || status === 410) {
    return new FeedError(status === 410 ? 'Feed is gone (410)' : 'Feed not found (404)', {
      transient: false,
      code: 'feed_not_found',
      status,
    });
  }
  return new FeedError(`Feed request refused (${status})`, { transient: false, code: 'feed_http_error', status });
}

function tooLarge(maxBytes: number): FeedError {
  return new FeedError(`Feed is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`, {
    transient: false,
    code: 'feed_too_large',
  });
}

/** The body as text, refusing to read past `maxBytes` whatever the server claimed. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder(declaredEncoding(bytes)).decode(bytes);
}

/** The encoding the XML declaration names, if this runtime knows it; UTF-8 otherwise. */
function declaredEncoding(bytes: Uint8Array): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
  const label = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head)?.[1];
  if (!label) return 'utf-8';
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return 'utf-8';
  }
}
