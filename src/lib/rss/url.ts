import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { FeedError } from '@/lib/errors';

/**
 * A feed URL is something a reviewer types and our server then fetches, so it
 * is checked twice: its shape here, before it is stored, and where it really
 * points — every hop of a redirect included — before each fetch.
 *
 * Basic protection against the server being pointed at itself or its
 * network (SSRF), not a complete one: a name is resolved before the fetch,
 * and the fetch resolves it again, so a host that answers differently the
 * second time is not caught.
 */

export type FeedUrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/**
 * The canonical form a feed is stored under, or why it cannot be one.
 *
 * Conservative on purpose: the fragment goes and the host is lower-cased, but
 * the path and query stay exactly as given — some feeds are chosen by them.
 */
export function normalizeFeedUrl(input: string): FeedUrlCheck {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, reason: 'No URL given.' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'That is not a URL.' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Only http and https feeds are supported.' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'A feed URL may not carry a username or password.' };
  }

  const blocked = blockedHostReason(url.hostname);
  if (blocked) return { ok: false, reason: blocked };

  url.hash = '';
  return { ok: true, url: url.toString() };
}

/** Why a host name or literal address may not be fetched, or null if it may — before any DNS. */
export function blockedHostReason(hostname: string): string | null {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '') return 'That URL has no host.';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'Local addresses are not allowed.';
  if (isIP(host) && isPrivateAddress(host)) return 'Private and local addresses are not allowed.';
  return null;
}

/**
 * Whether an address is one this server must never fetch: loopback, private,
 * link-local (cloud metadata lives there), carrier-grade NAT, multicast or
 * otherwise reserved, in IPv4 or IPv6 — including IPv4 written as IPv6.
 */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateV4(address);
  if (version === 6) return isPrivateV6(address.toLowerCase());
  return true;
}

function isPrivateV4(address: string): boolean {
  const [a, b, c] = address.split('.').map(Number) as [number, number, number, number];
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, TEST-NET-1
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

function isPrivateV6(address: string): boolean {
  if (address === '::' || address === '::1') return true;

  // IPv4-mapped (::ffff:10.0.0.1) and IPv4-compatible forms: judge the IPv4 address.
  const mapped = /^(?:0*:)*(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped) return isPrivateV4(mapped[1]!);
  const mappedHex = /^(?:0*:)*ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (mappedHex) {
    const high = parseInt(mappedHex[1]!, 16);
    const low = parseInt(mappedHex[2]!, 16);
    return isPrivateV4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }

  const first = parseInt(address.split(':')[0] || '0', 16);
  return (
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xff00) === 0xff00 // multicast
  );
}

/** Resolves a host name to every address it has. Injected by tests. */
export type HostLookup = (hostname: string) => Promise<string[]>;

export const lookupHost: HostLookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * Throws unless the URL is safe to fetch right now: the right scheme, no
 * credentials, and a host that is not — and does not resolve to — a private
 * or local address.
 */
export async function assertFetchable(url: URL, lookup: HostLookup = lookupHost): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeFeedUrlError('Only http and https feeds are supported.');
  }
  if (url.username || url.password) {
    throw new UnsafeFeedUrlError('A feed URL may not carry a username or password.');
  }

  const blocked = blockedHostReason(url.hostname);
  if (blocked) throw new UnsafeFeedUrlError(blocked);

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return;

  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new UnsafeFeedUrlError(`Could not resolve ${host}.`);
  }
  if (addresses.length === 0) throw new UnsafeFeedUrlError(`Could not resolve ${host}.`);
  if (addresses.some(isPrivateAddress)) {
    throw new UnsafeFeedUrlError(`${host} points to a private or local address.`);
  }
}

/** A feed URL this server refuses to fetch. Permanent: asking again changes nothing. */
export class UnsafeFeedUrlError extends FeedError {
  constructor(message: string) {
    super(message, { transient: false, code: 'feed_url_unsafe' });
  }
}
