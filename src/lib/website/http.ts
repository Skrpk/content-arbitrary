import { isIP } from 'node:net';
import { WebsiteError } from '@/lib/errors';
import { blockedHostReason, isPrivateAddress, lookupHost, type HostLookup } from '@/lib/rss/url';
import { SITE_NAME, SITE_URL } from '@/lib/site';

/**
 * One bounded GET of a public web address — a sitemap or a page — and
 * nothing more: no cookies, no credentials, no scripts, no page resources.
 *
 * The same protections as a feed's fetch (src/lib/rss/client.ts), on the same
 * address checks (src/lib/rss/url.ts): http(s) only, no credentials in the
 * URL, and a host that is not — and does not resolve to — a private or local
 * address, checked again on every redirect hop, with a limit on hops. The
 * body is read up to a fixed size and no further, whatever the server claims.
 */

export const WEBSITE_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 5;

const USER_AGENT = `Mozilla/5.0 (compatible; ${SITE_NAME.replace(/\s+/g, '')}/1.0; +${SITE_URL})`;

export interface WebsiteFetchOptions {
  fetchImpl?: typeof fetch;
  lookup?: HostLookup;
  timeoutMs?: number;
}

export interface FetchedResource {
  bytes: Uint8Array;
  /** Where it was finally read from, after any redirects. */
  finalUrl: string;
  /** The response's content type, lower-cased, without parameters; empty when it gave none. */
  contentType: string;
  /** The charset the content type named, if any. */
  charset: string | null;
}

export async function fetchPublic(
  address: string,
  options: WebsiteFetchOptions & { accept: string; maxBytes: number; what: string },
): Promise<FetchedResource> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookup = options.lookup ?? lookupHost;
  const timeoutMs = options.timeoutMs ?? WEBSITE_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);

  let url = parseUrl(address);

  for (let hop = 0; ; hop += 1) {
    await assertPublic(url, lookup);

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        redirect: 'manual',
        signal,
        credentials: 'omit',
        headers: { 'user-agent': USER_AGENT, accept: options.accept },
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new WebsiteError(`The ${options.what} did not answer within ${Math.round(timeoutMs / 1000)} s`, {
          transient: true,
          code: 'website_timeout',
          cause: error,
        });
      }
      throw new WebsiteError(`Could not reach the ${options.what}: ${error instanceof Error ? error.message : String(error)}`, {
        transient: true,
        code: 'website_network',
        cause: error,
      });
    }

    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) {
        throw new WebsiteError(`The ${options.what} redirected (${response.status}) without saying where`, {
          transient: false,
          code: 'website_redirect',
          status: response.status,
        });
      }
      if (hop >= MAX_REDIRECTS) {
        throw new WebsiteError(`The ${options.what} redirected too many times`, { transient: false, code: 'website_redirect' });
      }
      url = parseUrl(new URL(location, url).toString());
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw statusError(response, options.what);
    }

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw tooLarge(options.what, options.maxBytes);
    }

    const type = response.headers.get('content-type') ?? '';
    return {
      bytes: await readCapped(response, options.maxBytes, options.what),
      finalUrl: url.toString(),
      contentType: type.split(';')[0]!.trim().toLowerCase(),
      charset: /charset\s*=\s*"?([A-Za-z0-9._-]+)/i.exec(type)?.[1] ?? null,
    };
  }
}

/**
 * Throws unless the address is safe to fetch now: http(s), no credentials,
 * and a host that is not — and does not resolve to — a private or local one.
 */
export async function assertPublic(url: URL, lookup: HostLookup = lookupHost): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw unsafe('Only http and https addresses are supported.');
  }
  if (url.username || url.password) throw unsafe('An address may not carry a username or password.');

  const blocked = blockedHostReason(url.hostname);
  if (blocked) throw unsafe(blocked);

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return;

  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    throw unsafe(`Could not resolve ${host}.`);
  }
  if (addresses.length === 0) throw unsafe(`Could not resolve ${host}.`);
  if (addresses.some(isPrivateAddress)) throw unsafe(`${host} points to a private or local address.`);
}

/** An address this server refuses to fetch. Permanent: asking again changes nothing. */
function unsafe(message: string): WebsiteError {
  return new WebsiteError(message, { transient: false, code: 'website_url_unsafe' });
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw unsafe('That is not a URL.');
  }
}

/**
 * What a refusal means for trying again. Gone (404, 410) is permanent; a
 * server error, rate limiting or a block (401, 403 — often an anti-bot wall,
 * never worked around) is worth another try on a later run, a few times.
 */
function statusError(response: Response, what: string): WebsiteError {
  const status = response.status;
  if (status === 404 || status === 410) {
    return new WebsiteError(`The ${what} is gone (${status})`, { transient: false, code: 'website_not_found', status });
  }
  if (status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    return new WebsiteError(`The ${what} is rate limiting us (429)`, {
      transient: true,
      code: 'website_rate_limited',
      status,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
    });
  }
  if (status >= 500) return new WebsiteError(`The ${what} had a server error (${status})`, { transient: true, code: 'website_server_error', status });
  if (status === 401 || status === 403) {
    return new WebsiteError(`The ${what} refused us (${status})`, { transient: true, code: 'website_blocked', status });
  }
  return new WebsiteError(`The ${what} request was refused (${status})`, { transient: false, code: 'website_http_error', status });
}

function tooLarge(what: string, maxBytes: number): WebsiteError {
  return new WebsiteError(`The ${what} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`, {
    transient: false,
    code: 'website_too_large',
  });
}

/** The body, refusing to read past `maxBytes` whatever the server claimed. */
async function readCapped(response: Response, maxBytes: number, what: string): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge(what, maxBytes);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Text in the encoding named — by the response, or failing that by the document — or UTF-8. */
export function decodeText(bytes: Uint8Array, ...labels: (string | null | undefined)[]): string {
  for (const label of labels) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // Not an encoding this runtime knows: try the next.
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}
