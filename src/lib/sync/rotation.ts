import type { Database } from '@/lib/db';
import { syncState } from '@/db/schema';

/**
 * Who goes first in a run.
 *
 * A run that hits its time budget leaves whatever comes last for the next
 * run. With a fixed order that would be the same tenants and sources every
 * time, and they would never get through. So each run starts with whoever
 * has waited longest since their last sync — never-synced first — and the
 * cut-off moves around instead of always landing on the same ones.
 */

/** When each source last started a sync, keyed `<workspace id>|<sync state key>`. */
export async function loadLastSyncTimes(db: Database): Promise<Map<string, Date>> {
  const rows = await db
    .select({ workspaceId: syncState.workspaceId, source: syncState.source, lastSyncAt: syncState.lastSyncAt })
    .from(syncState);

  const times = new Map<string, Date>();
  for (const row of rows) {
    if (row.lastSyncAt) times.set(lastSyncKey(row.workspaceId, row.source), row.lastSyncAt);
  }
  return times;
}

export function lastSyncKey(workspaceId: number, stateKey: string): string {
  return `${workspaceId}|${stateKey}`;
}

/**
 * Least recently synced first; never synced before anything else. Stable, so
 * among equals the original order stands.
 */
export function longestWaitingFirst<T>(items: T[], lastSyncOf: (item: T) => Date | undefined): T[] {
  return items
    .map((item, index) => ({ item, index, at: lastSyncOf(item)?.getTime() ?? Number.NEGATIVE_INFINITY }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map(({ item }) => item);
}

/**
 * A tenant has waited as long as its longest-waiting enabled source; one with
 * a source never synced — new, or just given another account — goes first.
 * Only enabled sources count: a removed account's leftover cursor would
 * otherwise keep its tenant at the front for good.
 */
export function tenantWaitedSince(
  times: Map<string, Date>,
  workspaceId: number,
  stateKeys: string[],
): Date | undefined {
  let oldest: Date | undefined;
  for (const stateKey of stateKeys) {
    const at = times.get(lastSyncKey(workspaceId, stateKey));
    if (!at) return undefined;
    if (!oldest || at < oldest) oldest = at;
  }
  return oldest;
}
