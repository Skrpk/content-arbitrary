import type { Source, SourcePlatform } from '@/db/schema';
import type { Logger } from '@/lib/logger';
import type { FetchFeedOptions } from '@/lib/rss/client';
import type { CandidateContext } from '@/lib/sync/process-candidate';
import { syncRssSource } from '@/lib/sync/sync-rss-source';
import { syncTelegramSource } from '@/lib/sync/sync-telegram-source';
import { syncXSource } from '@/lib/sync/sync-x-source';
import type { FetchChannelOptions } from '@/lib/telegram-channel/client';
import type { XClient } from '@/lib/x/client';
import type { SourceSyncSummary } from '@/types';

/**
 * What a platform does in a sync run, behind one shape: the orchestrator
 * (src/lib/sync/sync-posts.ts) hands every source to its platform's adapter
 * and knows nothing of X, feeds or channels.
 *
 * An adapter reads what is new at its source, in its own way — a cursor on
 * X and Telegram, identity on a feed — and hands each new post, normalised,
 * to processCandidate, which every platform shares from claim to review. It
 * keeps its own cursor, and never throws: a source that fails says why in its
 * summary, and the run moves on.
 *
 * A new platform is an adapter here, an identity in src/lib/sources/display.ts
 * and a value of `source_platform`; the type of SOURCE_ADAPTERS does not
 * compile without the first.
 */

/** How each platform is reached, made once per run; each adapter takes what it needs. */
export interface SourceClients {
  xClient: XClient;
  /** How RSS / Atom feeds are fetched; injected by tests and the local runner. */
  feedFetch?: FetchFeedOptions;
  /** How public Telegram channels' pages are fetched; injected by tests and the local runner. */
  channelFetch?: FetchChannelOptions;
}

/** Everything a source's pass is handed, whatever its platform. */
export interface SourcePassContext extends CandidateContext {
  logger: Logger;
  clients: SourceClients;
  /** When to stop taking new posts (epoch ms); unset, there is no limit. */
  deadline?: number;
  now?: () => number;
}

export interface SourceAdapter {
  platform: SourcePlatform;
  /** One pass over one source. Never throws. */
  sync(source: Source, context: SourcePassContext): Promise<SourceSyncSummary>;
}

const SOURCE_ADAPTERS: { readonly [P in SourcePlatform]: SourceAdapter & { platform: P } } = {
  x: {
    platform: 'x',
    sync: (source, { clients, ...context }) => syncXSource(source, { ...context, xClient: clients.xClient }),
  },
  rss: {
    platform: 'rss',
    sync: (source, { clients, ...context }) => syncRssSource(source, { ...context, feedFetch: clients.feedFetch }),
  },
  telegram: {
    platform: 'telegram',
    sync: (source, { clients, ...context }) =>
      syncTelegramSource(source, { ...context, channelFetch: clients.channelFetch }),
  },
};

export function sourceAdapter(platform: SourcePlatform): SourceAdapter {
  return SOURCE_ADAPTERS[platform];
}
