import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import type { Candidate, CandidateKind } from '@/lib/onboarding/candidates';
import {
  DISCOVERY_CANDIDATE_TIMEOUT_MS,
  DISCOVERY_CONCURRENCY,
  DISCOVERY_MAX_CANDIDATES,
  DISCOVERY_SEARCH_TIMEOUT_MS,
  DISCOVERY_VALIDATION_BUDGET_MS,
  SOURCES_AUTO_ACTIVATED,
  SOURCES_RESERVE_MAX,
} from '@/lib/onboarding/limits';
import { historySignals, strongEnough, type HistoryItemSignal } from '@/lib/onboarding/link-signals';
import { discoverSiteFeed } from '@/lib/onboarding/site-feed';
import { suggestionToCandidate, type SourceDiscoverer } from '@/lib/onboarding/source-discovery';
import { resolveTelegramSource } from '@/lib/sources/add-telegram';
import { resolveYouTubeSource } from '@/lib/sources/add-youtube';
import type { ResolvedSource } from '@/lib/sources/resolve';
import type { YouTubeClient } from '@/lib/youtube/client';

/**
 * The sources an onboarded channel starts with (§15–§19): what its history
 * points at, and what a web search finds, each resolved and checked — a
 * public Telegram channel, a YouTube channel, a site's feed or sitemap — then
 * ranked, and the best five picked with some variety. The rest is kept, in
 * order, to offer when one is removed.
 *
 * Nothing is stored: activating them is the caller's (§22).
 */

export interface DiscoveryDeps {
  youtube: YouTubeClient | null;
  /** The web search; without it, history alone. */
  discoverer: SourceDiscoverer | null;
  logger: Logger;
  /** Every fetch of a candidate; injected by tests. */
  fetchImpl?: typeof fetch;
  lookup?: (hostname: string) => Promise<string[]>;
  now?: () => number;
}

export interface CheckedCandidate extends Candidate {
  source: ResolvedSource;
  /** For a website: what it is followed by. */
  via: 'rss' | 'news_sitemap' | 'sitemap' | null;
  score: number;
}

export interface DiscoveryResult {
  picked: CheckedCandidate[];
  reserve: CheckedCandidate[];
  failed: { key: string; origin: Candidate['origin']; reason: string }[];
  stats: {
    fromHistory: number;
    fromSearch: number;
    checked: number;
    ownSite: string | null;
    xLinks: number;
    webSearches: number;
    searchError: string | null;
  };
}

export async function discoverSources(
  input: {
    channel: { username: string; title: string; language: string | null; editorialProfile: string | null; topics: string[] };
    history: HistoryItemSignal[];
  },
  deps: DiscoveryDeps,
): Promise<DiscoveryResult> {
  const now = deps.now ?? Date.now;
  const own = input.channel.username.toLowerCase();
  const signals = historySignals(input.history, { username: own });

  // A video's channel is the source: count each video's posts towards it.
  const fromHistory = [...signals.candidates];
  if (deps.youtube && signals.youtubeVideos.size > 0) {
    try {
      const videos = await deps.youtube.getVideos([...signals.youtubeVideos.keys()].slice(0, 50));
      for (const video of videos) {
        const key = `youtube:${video.channelId}`;
        const existing = fromHistory.find((candidate) => candidate.key === key);
        const posts = signals.youtubeVideos.get(video.id) ?? 0;
        if (existing) existing.links += posts;
        else
          fromHistory.push({
            key,
            platform: 'youtube',
            target: `https://www.youtube.com/channel/${video.channelId}`,
            name: video.channelTitle,
            origin: 'history_link',
            links: posts,
            forwards: 0,
            reason: null,
            kind: null,
            organization: null,
          });
      }
    } catch (error) {
      deps.logger.warn('discovery.youtube_videos_failed', { error: describeError(error) });
    }
  }
  const strong = strongEnough(fromHistory).sort(byEvidence);

  let fromSearch: Candidate[] = [];
  let webSearches = 0;
  let searchError: string | null = null;
  if (deps.discoverer) {
    try {
      const found = await deps.discoverer.discover(
        {
          channelTitle: input.channel.title,
          language: input.channel.language,
          editorialProfile: input.channel.editorialProfile,
          topics: input.channel.topics,
          known: strong.slice(0, 10).map((candidate) => ({
            name: candidate.name ?? candidate.target,
            evidence: candidate.forwards > 0 ? `forwarded ${candidate.forwards} times` : `linked ${candidate.links} times`,
          })),
          exclude: [`https://t.me/${own}`, ...(signals.ownSite ? [signals.ownSite] : [])],
        },
        { timeoutMs: DISCOVERY_SEARCH_TIMEOUT_MS },
      );
      webSearches = found.webSearches;
      fromSearch = found.suggestions.map(suggestionToCandidate).filter((candidate): candidate is Candidate => candidate !== null);
    } catch (error) {
      // The history's sources are still worth having: never block onboarding on the search.
      searchError = describeError(error);
      deps.logger.warn('discovery.search_failed', { error: searchError });
    }
  }

  const candidates = merge(strong, fromSearch).filter(
    (candidate) => candidate.key !== `telegram:${own}` && candidate.key !== `site:${signals.ownSite}`,
  );
  const toCheck = [...candidates].sort((a, b) => scoreOf(b) - scoreOf(a)).slice(0, DISCOVERY_MAX_CANDIDATES);

  const deadline = now() + DISCOVERY_VALIDATION_BUDGET_MS;
  const failed: DiscoveryResult['failed'] = [];
  const checked: CheckedCandidate[] = [];
  await mapLimited(toCheck, DISCOVERY_CONCURRENCY, async (candidate) => {
    if (now() >= deadline) {
      failed.push({ key: candidate.key, origin: candidate.origin, reason: 'out_of_time' });
      return;
    }
    const outcome = await withTimeout(check(candidate, deps, Math.min(deadline, now() + DISCOVERY_CANDIDATE_TIMEOUT_MS)), DISCOVERY_CANDIDATE_TIMEOUT_MS).catch(
      (error: unknown) => ({ ok: false as const, reason: describeError(error) }),
    );
    if (outcome.ok) checked.push({ ...candidate, source: outcome.source, via: outcome.via, score: scoreOf(candidate) });
    else failed.push({ key: candidate.key, origin: candidate.origin, reason: outcome.reason.slice(0, 200) });
  });

  // Two candidates may be one source (a site and its feed found twice): the better one stays.
  // And the channel's own accounts elsewhere — its YouTube, say — are not its sources.
  const ownName = comparable(input.channel.title);
  const unique = new Map<string, CheckedCandidate>();
  for (const candidate of checked.sort((a, b) => b.score - a.score)) {
    if (ownName && comparable(candidate.source.username) === ownName) {
      failed.push({ key: candidate.key, origin: candidate.origin, reason: 'the_channel_itself' });
      continue;
    }
    const id = `${candidate.source.platform}:${candidate.source.externalId.toLowerCase()}`;
    if (!unique.has(id)) unique.set(id, candidate);
  }
  const ranked = [...unique.values()];
  const picked = pick(ranked);
  const reserve = ranked.filter((candidate) => !picked.includes(candidate)).slice(0, SOURCES_RESERVE_MAX);

  deps.logger.info('discovery.completed', {
    fromHistory: strong.length,
    fromSearch: fromSearch.length,
    checked: ranked.length,
    failed: failed.length,
    picked: picked.map((candidate) => candidate.key),
  });
  return {
    picked,
    reserve,
    failed,
    stats: {
      fromHistory: strong.length,
      fromSearch: fromSearch.length,
      checked: ranked.length,
      ownSite: signals.ownSite,
      xLinks: signals.xLinks,
      webSearches,
      searchError,
    },
  };
}

type CheckOutcome = { ok: true; source: ResolvedSource; via: CheckedCandidate['via'] } | { ok: false; reason: string };

async function check(candidate: Candidate, deps: DiscoveryDeps, deadline: number): Promise<CheckOutcome> {
  const timeoutMs = Math.max(1_000, deadline - (deps.now ?? Date.now)());
  if (candidate.platform === 'telegram') {
    const resolved = await resolveTelegramSource({ channel: candidate.target, channelFetch: { fetchImpl: deps.fetchImpl, timeoutMs } });
    return resolved.ok ? { ok: true, source: resolved.source, via: null } : { ok: false, reason: resolved.reason };
  }
  if (candidate.platform === 'youtube') {
    if (!deps.youtube) return { ok: false, reason: 'youtube_not_configured' };
    const resolved = await resolveYouTubeSource({ channel: candidate.target, youtube: deps.youtube });
    return resolved.ok ? { ok: true, source: resolved.source, via: null } : { ok: false, reason: resolved.reason };
  }
  const feed = await discoverSiteFeed(candidate.target, {
    fetchImpl: deps.fetchImpl,
    lookup: deps.lookup,
    timeoutMs: Math.min(6_000, timeoutMs),
    deadline,
    now: deps.now,
  });
  return feed ? { ok: true, source: feed.source, via: feed.kind } : { ok: false, reason: 'no_feed_or_sitemap' };
}

/** §19's order: what the channel itself forwards and links most, then by kind, primary first. */
const KIND_SCORE: Record<CandidateKind, number> = { official: 400, specialist: 300, curator: 200, creator: 150, aggregator: 50 };

export function scoreOf(candidate: Candidate): number {
  const evidence = candidate.forwards * 3 + candidate.links;
  return (evidence > 0 ? 1_000 + evidence * 10 : 0) + (candidate.kind ? KIND_SCORE[candidate.kind] : 100);
}

function byEvidence(a: Candidate, b: Candidate): number {
  return b.forwards * 3 + b.links - (a.forwards * 3 + a.links);
}

/** One candidate per key: the history's counts, the search's reason and judgement. */
function merge(history: Candidate[], search: Candidate[]): Candidate[] {
  const byKey = new Map<string, Candidate>(history.map((candidate) => [candidate.key, { ...candidate }]));
  for (const candidate of search) {
    const known = byKey.get(candidate.key);
    if (known) {
      known.reason ??= candidate.reason;
      known.kind ??= candidate.kind;
      known.organization ??= candidate.organization;
      // The search names a source as people know it ("PlayStation Blog"), not by its address.
      known.name = candidate.name ?? known.name;
    } else byKey.set(candidate.key, candidate);
  }
  return [...byKey.values()];
}

/**
 * The best SOURCES_AUTO_ACTIVATED, with variety: at most 2 of one platform
 * and 1 of one organisation, and — when there are any — at least one the
 * channel's history points at and one the search found. The platform limit
 * gives way when there would otherwise be fewer than five.
 */
export function pick(ranked: CheckedCandidate[], count = SOURCES_AUTO_ACTIVATED): CheckedCandidate[] {
  const chosen: CheckedCandidate[] = [];
  const fits = (candidate: CheckedCandidate, platformCap: number) =>
    !chosen.includes(candidate) &&
    chosen.filter((other) => other.source.platform === candidate.source.platform).length < platformCap &&
    !(candidate.organization && chosen.some((other) => other.organization === candidate.organization)) &&
    !chosen.some((other) => sameOutlet(other, candidate));

  for (const cap of [2, count]) {
    for (const candidate of ranked) {
      if (chosen.length >= count) break;
      if (fits(candidate, cap)) chosen.push(candidate);
    }
  }

  const isHistory = (candidate: CheckedCandidate) => candidate.origin === 'history_link' || candidate.origin === 'history_forward';
  for (const wanted of [isHistory, (candidate: CheckedCandidate) => candidate.origin === 'discovery']) {
    if (chosen.some(wanted)) continue;
    const best = ranked.find((candidate) => wanted(candidate) && !chosen.includes(candidate));
    if (!best) continue;
    // In place of the weakest pick of the kind there is more than one of.
    const others = chosen.filter((candidate) => !wanted(candidate));
    const weakest = others.at(-1);
    if (weakest && chosen.length >= count) chosen.splice(chosen.indexOf(weakest), 1, best);
    else chosen.push(best);
  }
  return chosen.sort((a, b) => b.score - a.score).slice(0, count);
}

/** A name as compared: lower-case letters and digits only. */
function comparable(name: string | null | undefined): string {
  return (name ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * The words an outlet goes by: a Telegram username or a YouTube handle without
 * its "news", "ua", "official" and digits; a site's host labels but its suffix.
 * `@epravda` and `epravda.com.ua`, or `@oboronka1` and `oboronka.mezha.ua`,
 * share one — the same outlet on two platforms, which would bring the same news twice.
 */
export function outletStems(candidate: Pick<CheckedCandidate, 'source'>): Set<string> {
  const { platform, externalId, username } = candidate.source;
  const stem = (word: string) => word.toLowerCase().replace(/(_?(news|ua|official|channel|tv|online)|\d+)$/g, '').replace(/[^a-z0-9]/g, '');
  const words =
    platform === 'telegram'
      ? [externalId]
      : platform === 'youtube'
        ? [username.replace(/\s+/g, '')]
        : (() => {
            try {
              return new URL(externalId).hostname.split('.').filter((label) => !['www', 'feeds', 'rss', 'news', 'm'].includes(label)).slice(0, -1);
            } catch {
              return [];
            }
          })();
  return new Set(words.map(stem).filter((word) => word.length >= 4));
}

function sameOutlet(a: CheckedCandidate, b: CheckedCandidate): boolean {
  if (a.source.platform === b.source.platform) return false;
  const stems = outletStems(a);
  return [...outletStems(b)].some((word) => stems.has(word));
}

async function mapLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
    }),
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
