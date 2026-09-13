import type postgres from 'postgres';

/**
 * Postgres advisory locks give us a cluster-wide mutex without an extra service
 * such as Redis.
 *
 * Vercel explicitly warns that a cron job may be invoked again while the previous
 * run is still in flight, and that delivery can occasionally be duplicated. This
 * lock is the first of our two defences; the UNIQUE constraint on
 * `processed_posts.x_post_id` is the second, and is the one that actually makes
 * double-publishing impossible.
 */

/** Stable 32-bit key derived from a string, for pg_try_advisory_lock(key). */
export function advisoryLockKey(name: string): number {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // Constrain to a positive signed 32-bit integer.
  return hash & 0x7fffffff;
}

export interface SyncLock {
  acquired: boolean;
  release: () => Promise<void>;
}

/**
 * Try to take a session-level advisory lock. Returns immediately (never waits)
 * so an overlapping cron invocation exits fast rather than piling up.
 *
 * The lock is bound to one dedicated connection, which is reserved for the
 * lifetime of the lock and released along with it — a pooled connection could
 * otherwise unlock from a different session than the one that locked.
 */
export async function acquireSyncLock(sql: postgres.Sql, name: string): Promise<SyncLock> {
  const key = advisoryLockKey(name);
  const reserved = await sql.reserve();

  try {
    const rows = await reserved<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${key}) AS locked
    `;

    if (!rows[0]?.locked) {
      reserved.release();
      return { acquired: false, release: async () => {} };
    }

    let released = false;
    return {
      acquired: true,
      release: async () => {
        if (released) return;
        released = true;
        try {
          await reserved`SELECT pg_advisory_unlock(${key})`;
        } finally {
          reserved.release();
        }
      },
    };
  } catch (error) {
    reserved.release();
    throw error;
  }
}
