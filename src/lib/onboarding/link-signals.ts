import { and, eq } from 'drizzle-orm';
import { publicationHistoryItems } from '@/db/schema';
import type { Database } from '@/lib/db';
import { isBlockedDomain, registrableDomain, type Candidate } from '@/lib/onboarding/candidates';

/**
 * Sources the channel itself points at (§15 A–B): the sites, YouTube channels
 * and Telegram channels its posts link to, and the channels it forwards —
 * the strongest sign of all that it draws on them.
 *
 * Noise is left out: posts that are ads, links to shops, payments, shorteners,
 * social networks, the channel itself, and its own website — a site named
 * like the channel (`pravda.com.ua` for @ukrpravda_news) that a large share
 * of its posts link to is where it publishes, not where it reads. Either
 * alone is not enough: a site linked a lot is a curator's main source (IGN
 * for a games channel), and a channel may be named after what it covers
 * (@playstationua and blog.playstation.com).
 * Something mentioned only once is not a habit, and is left out too.
 */

export const MIN_EVIDENCE = 2;
/** A site named like the channel and linked from at least this share of its posts is its own. */
const OWN_SITE_SHARE = 0.25;
// \b knows only Latin letters: the hashtag's end is spelled out, so #реклама matches and #рекламодавці does not.
const AD_POST = /#(реклама|ad|ads|промо|promo)(?![\p{L}\p{N}_])|партнерськ|sponsored|на правах реклами/iu;

export interface HistoryItemSignal {
  text: string | null;
  metadata: Record<string, unknown> | null;
}

export interface HistorySignals {
  candidates: Candidate[];
  /** YouTube videos linked, by id, with how many posts link each: their channels are found later. */
  youtubeVideos: Map<string, number>;
  /** Links to X: counted, never suggested (D4). */
  xLinks: number;
  /** The site taken for the channel's own, if any. */
  ownSite: string | null;
  adPostsSkipped: number;
}

/** Signals from one channel's history items; pure, so it is tested without a database. */
export function historySignals(items: HistoryItemSignal[], channel: { username: string }): HistorySignals {
  const own = channel.username.toLowerCase();
  const found = new Map<string, Candidate>();
  const domainPosts = new Map<string, number>();
  const youtubeVideos = new Map<string, number>();
  let xLinks = 0;
  let adPostsSkipped = 0;

  const bump = (key: string, init: () => Omit<Candidate, 'links' | 'forwards'>, field: 'links' | 'forwards') => {
    const candidate = found.get(key) ?? { ...init(), links: 0, forwards: 0 };
    candidate[field] += 1;
    found.set(key, candidate);
  };

  for (const item of items) {
    if (item.text && AD_POST.test(item.text)) {
      adPostsSkipped += 1;
      continue;
    }
    const metadata = item.metadata ?? {};

    const forwardedFrom = typeof metadata.forwardedFrom === 'string' ? metadata.forwardedFrom.toLowerCase() : null;
    if (forwardedFrom && forwardedFrom !== own) {
      bump(`telegram:${forwardedFrom}`, () => telegram(forwardedFrom, 'history_forward'), 'forwards');
    }

    // Each source counted once per post, however many times the post links it.
    const inPost = new Set<string>();
    const domainsInPost = new Set<string>();
    for (const link of Array.isArray(metadata.outboundLinks) ? metadata.outboundLinks : []) {
      const url = parseUrl((link as { url?: unknown }).url);
      if (!url) continue;
      const host = url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
      const domain = registrableDomain(host);

      if (domain === 'x.com' || domain === 'twitter.com') {
        xLinks += 1;
        continue;
      }
      if (host === 't.me' || host === 'telegram.me') {
        const name = url.pathname.split('/').filter(Boolean)[0]?.toLowerCase();
        if (name && name !== own && /^[a-z][a-z0-9_]{3,31}$/.test(name) && !inPost.has(`telegram:${name}`)) {
          inPost.add(`telegram:${name}`);
          bump(`telegram:${name}`, () => telegram(name, 'history_link'), 'links');
        }
        continue;
      }
      if (domain === 'youtube.com' || domain === 'youtu.be') {
        const video = youtubeVideoId(url);
        if (video) {
          if (!inPost.has(`video:${video}`)) youtubeVideos.set(video, (youtubeVideos.get(video) ?? 0) + 1);
          inPost.add(`video:${video}`);
          continue;
        }
        const channelRef = youtubeChannelRef(url);
        if (channelRef && !inPost.has(`youtube:${channelRef}`)) {
          inPost.add(`youtube:${channelRef}`);
          bump(`youtube:${channelRef}`, () => ({
            key: `youtube:${channelRef}`,
            platform: 'youtube',
            target: `https://www.youtube.com/${channelRef.startsWith('UC') ? `channel/${channelRef}` : channelRef}`,
            name: null,
            origin: 'history_link',
            reason: null,
            kind: null,
            organization: null,
          }), 'links');
        }
        continue;
      }
      if (isBlockedDomain(domain)) continue;
      domainsInPost.add(domain);
      if (!inPost.has(`site:${domain}`)) {
        inPost.add(`site:${domain}`);
        bump(`site:${domain}`, () => ({
          key: `site:${domain}`,
          platform: 'website',
          target: `https://${host}/`,
          name: domain,
          origin: 'history_link',
          reason: null,
          kind: null,
          organization: domain,
        }), 'links');
      }
    }
    for (const domain of domainsInPost) domainPosts.set(domain, (domainPosts.get(domain) ?? 0) + 1);
  }

  const counted = items.length - adPostsSkipped;
  const ownSite =
    [...domainPosts.entries()]
      .filter(([domain, posts]) => counted > 0 && posts / counted >= OWN_SITE_SHARE && namedLike(domain, own))
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  if (ownSite) found.delete(`site:${ownSite}`);

  // Forwarded at all is the stronger sign, whichever was seen first.
  const candidates = [...found.values()].map((candidate) => ({
    ...candidate,
    origin: candidate.forwards > 0 ? ('history_forward' as const) : candidate.origin,
  }));
  return { candidates, youtubeVideos, xLinks, ownSite, adPostsSkipped };
}

/** Whether a site's name and the channel's username are one name: `pravda` in `ukrpravda_news`, `tsn` and `tsn_ua`. */
export function namedLike(domain: string, username: string): boolean {
  const site = domain.split('.')[0]!.replace(/[^a-z0-9]/g, '');
  const channel = username.toLowerCase().replace(/[^a-z0-9_]/g, '');
  const stem = channel.replace(/(_?(news|ua|official|channel|online|media)|\d+)+$/g, '').replace(/_/g, '');
  if (site.length < 3 || stem.length < 3) return false;
  return channel.replace(/_/g, '').includes(site) || site.includes(stem);
}

function telegram(name: string, origin: Candidate['origin']): Omit<Candidate, 'links' | 'forwards'> {
  return { key: `telegram:${name}`, platform: 'telegram', target: name, name: `@${name}`, origin, reason: null, kind: null, organization: null };
}

function parseUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

function youtubeVideoId(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  const [first, second] = url.pathname.split('/').filter(Boolean);
  const id = host.endsWith('youtu.be') ? first : first === 'watch' ? url.searchParams.get('v') : first === 'shorts' || first === 'live' ? second : null;
  return id && /^[0-9A-Za-z_-]{11}$/.test(id) ? id : null;
}

/** `@handle` or `UC…` from a channel's link; null for anything else. */
function youtubeChannelRef(url: URL): string | null {
  const [first, second] = url.pathname.split('/').filter(Boolean);
  if (first?.startsWith('@') && /^@[0-9A-Za-z._-]{3,30}$/.test(first)) return first;
  if (first === 'channel' && second && /^UC[0-9A-Za-z_-]{22}$/.test(second)) return second;
  return null;
}

/** Only what was seen at least MIN_EVIDENCE times. */
export function strongEnough(candidates: Candidate[]): Candidate[] {
  return candidates.filter((candidate) => candidate.links + candidate.forwards >= MIN_EVIDENCE);
}

/** The history items of one channel in a workspace, as signals read them. */
export async function loadHistorySignals(
  db: Database,
  input: { workspaceId: number; publicationKey: string },
): Promise<HistoryItemSignal[]> {
  return db
    .select({ text: publicationHistoryItems.text, metadata: publicationHistoryItems.metadata })
    .from(publicationHistoryItems)
    .where(and(eq(publicationHistoryItems.workspaceId, input.workspaceId), eq(publicationHistoryItems.publicationKey, input.publicationKey)));
}
