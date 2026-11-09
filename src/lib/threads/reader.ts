import { and, eq, gt } from 'drizzle-orm';
import { threadsAccounts, type ThreadsAccount } from '@/db/schema';
import type { Database } from '@/lib/db';
import type { Env } from '@/lib/env';
import { threadsAccessToken } from '@/lib/threads/accounts';
import { THREADS_DISCOVERY_SCOPE, threadsApp, type ThreadsApp } from '@/lib/threads/config';

/**
 * Whose account reads Threads sources.
 *
 * Threads lets nothing be read anonymously: every request is made with some
 * connected account's token, and each token may make 1,000 requests a day.
 *
 *  - `shared` — one account, THREADS_READER_USERNAME, reads every channel's
 *    sources: nothing for a channel to connect, one budget for all.
 *  - `own_first` — a channel whose own connected account may read profiles
 *    reads its sources with it, on its own budget; the shared account reads
 *    for the rest.
 *
 * Only an account that granted profile discovery can read, and only while
 * its token lasts.
 */

export interface ThreadsReading {
  app: ThreadsApp;
  mode: Env['THREADS_READER_MODE'];
  sharedUsername: string | null;
}

export function threadsReading(
  env: Pick<Env, 'THREADS_APP_ID' | 'THREADS_APP_SECRET' | 'WEB_APP_URL' | 'THREADS_READER_MODE' | 'THREADS_READER_USERNAME'>,
): ThreadsReading | null {
  const app = threadsApp(env);
  return app ? { app, mode: env.THREADS_READER_MODE, sharedUsername: env.THREADS_READER_USERNAME ?? null } : null;
}

export interface ThreadsReader {
  accountId: number;
  username: string;
  token: string;
}

export const NO_THREADS_READER =
  'No Threads account can read sources yet: connect one with profile discovery, and name it in THREADS_READER_USERNAME.';

/** The account that reads this channel's sources, or null when none may. */
export async function threadsReaderFor(db: Database, reading: ThreadsReading, workspaceId: number, now = new Date()): Promise<ThreadsReader | null> {
  const usable = (account: ThreadsAccount | undefined) =>
    account && account.scopes.includes(THREADS_DISCOVERY_SCOPE) ? reader(account, reading.app) : null;

  if (reading.mode === 'own_first') {
    const [own] = await db
      .select()
      .from(threadsAccounts)
      .where(and(eq(threadsAccounts.workspaceId, workspaceId), gt(threadsAccounts.tokenExpiresAt, now)))
      .limit(1);
    const found = usable(own);
    if (found) return found;
  }

  if (!reading.sharedUsername) return null;
  const shared = await db
    .select()
    .from(threadsAccounts)
    .where(and(eq(threadsAccounts.username, reading.sharedUsername), gt(threadsAccounts.tokenExpiresAt, now)));
  // The same account may be connected on several channels: any of its tokens reads the same.
  for (const account of shared) {
    const found = usable(account);
    if (found) return found;
  }
  return null;
}

function reader(account: ThreadsAccount, app: ThreadsApp): ThreadsReader {
  return { accountId: account.id, username: account.username, token: threadsAccessToken(account, app) };
}

/**
 * A run's share of each reading account's daily 1,000 requests. The sync runs
 * every quarter of an hour, 96 times a day; eight a run keeps an account well
 * under the limit. Sources wait their turn when it is spent — the longest
 * waiting go first in the next run (src/lib/sync/rotation.ts).
 */
export const THREADS_READS_PER_RUN = 8;

export class ThreadsReadBudget {
  private readonly used = new Map<string, number>();

  constructor(private readonly perRun = THREADS_READS_PER_RUN) {}

  /** Take one request from this account's share; false when it is spent. */
  take(username: string): boolean {
    const used = this.used.get(username) ?? 0;
    if (used >= this.perRun) return false;
    this.used.set(username, used + 1);
    return true;
  }
}
