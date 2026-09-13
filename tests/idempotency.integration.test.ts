import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import { processedPosts, syncState, telegramMessages } from '@/db/schema';
import {
  claimPost,
  findTerminalPostIds,
  getStatusCounts,
  getSyncState,
  markFailed,
  markPublished,
  markSkipped,
  upsertSyncState,
} from '@/lib/sync/repository';
import { acquireSyncLock, advisoryLockKey } from '@/lib/sync/locks';

/**
 * These tests run against a real PostgreSQL instance, because the guarantees
 * under test — UNIQUE constraint races, ON CONFLICT semantics and advisory
 * locks — only exist in the database. A mock would prove nothing.
 *
 * Start one with:
 *   docker run -d --name ca-test-pg -e POSTGRES_PASSWORD=test \
 *     -e POSTGRES_DB=content_arbitrary_test -p 55432:5432 postgres:16-alpine
 *   TEST_DATABASE_URL=postgresql://postgres:test@localhost:55432/content_arbitrary_test \
 *     npm test
 *
 * Without TEST_DATABASE_URL the suite is skipped rather than failing, so the
 * unit tests still run on a machine with no Docker.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

const basePost = {
  xPostId: '1750000000000000001',
  xPostUrl: 'https://x.com/testaccount/status/1750000000000000001',
  xAuthorUsername: 'testaccount',
  xCreatedAt: new Date('2026-01-01T00:00:00Z'),
  maxRetryAttempts: 5,
};

beforeAll(async () => {
  if (!connectionString) return;
  sql = postgres(connectionString, { max: 10, prepare: false });
  db = drizzle(sql, { schema });
});

afterAll(async () => {
  if (sql) await sql.end();
});

beforeEach(async () => {
  if (!connectionString) return;
  await db.delete(telegramMessages);
  await db.delete(processedPosts);
  await db.delete(syncState);
});

describeIfDb('duplicate protection', () => {
  it('claims a brand-new post exactly once', async () => {
    const first = await claimPost(db, basePost);
    expect(first.claimed).toBe(true);
    expect(first.row?.status).toBe('processing');

    const second = await claimPost(db, basePost);
    expect(second.claimed).toBe(false);
    expect(second.reason).toBe('in-flight');
  });

  it('never claims an already-published post again', async () => {
    const claim = await claimPost(db, basePost);
    await markPublished(db, {
      id: claim.row!.id,
      telegramChatId: '-1001234567890',
      primaryMessageId: 500,
      telegramMethod: 'sendPhoto',
      mediaCount: 1,
      messages: [{ messageId: 500, mediaIndex: 0, kind: 'media' }],
    });

    const again = await claimPost(db, basePost);
    expect(again.claimed).toBe(false);
    expect(again.reason).toBe('already-published');
  });

  it('enforces uniqueness of x_post_id at the database level', async () => {
    await db.insert(processedPosts).values({
      xPostId: basePost.xPostId,
      xPostUrl: basePost.xPostUrl,
      status: 'published',
    });

    // Drizzle wraps the driver error, so assert on the underlying Postgres
    // code (23505 = unique_violation) rather than the wrapper's message.
    const error = await db
      .insert(processedPosts)
      .values({
        xPostId: basePost.xPostId,
        xPostUrl: basePost.xPostUrl,
        status: 'pending',
      })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause;
    expect(cause?.code).toBe('23505');
    expect(cause?.constraint_name).toBe('processed_posts_x_post_id_key');
  });

  it('lets exactly one of ten concurrent claims win', async () => {
    // The real race: ten simultaneous invocations, one post.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimPost(db, basePost)),
    );

    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect(results.filter((r) => !r.claimed)).toHaveLength(9);

    const rows = await db.select().from(processedPosts).where(eq(processedPosts.xPostId, basePost.xPostId));
    expect(rows).toHaveLength(1);
  });

  it('lets exactly one claim win for each of several concurrent posts', async () => {
    const ids = ['1750000000000000001', '1750000000000000002', '1750000000000000003'];

    const results = await Promise.all(
      ids.flatMap((xPostId) =>
        Array.from({ length: 5 }, () =>
          claimPost(db, { ...basePost, xPostId, xPostUrl: `https://x.com/a/status/${xPostId}` }),
        ),
      ),
    );

    expect(results.filter((r) => r.claimed)).toHaveLength(3);
    expect(await db.select().from(processedPosts)).toHaveLength(3);
  });
});

describeIfDb('retry eligibility', () => {
  it('reclaims a failed post while retries remain', async () => {
    const claim = await claimPost(db, basePost);
    await markFailed(db, {
      id: claim.row!.id,
      errorMessage: 'Telegram 503',
      permanent: false,
      maxRetryAttempts: 5,
    });

    const retry = await claimPost(db, basePost);
    expect(retry.claimed).toBe(true);
    expect(retry.row?.retryCount).toBe(1);
  });

  it('stops retrying once the attempt budget is exhausted', async () => {
    let claim = await claimPost(db, basePost);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await markFailed(db, {
        id: claim.row!.id,
        errorMessage: `attempt ${attempt}`,
        permanent: false,
        maxRetryAttempts: 5,
      });
      claim = await claimPost(db, basePost);
    }

    expect(claim.claimed).toBe(false);

    const row = (await db.select().from(processedPosts).where(eq(processedPosts.xPostId, basePost.xPostId)))[0];
    expect(row?.status).toBe('skipped');
    expect(row?.retryCount).toBe(5);
  });

  it('never reclaims a permanently skipped post', async () => {
    const claim = await claimPost(db, basePost);
    await markSkipped(db, { id: claim.row!.id, reason: 'video is 60.0 MB, above the 50 MB limit' });

    const again = await claimPost(db, basePost);
    expect(again.claimed).toBe(false);
    expect(again.reason).toBe('permanently-failed');
  });

  it('does not increment retryCount for a permanent failure', async () => {
    const claim = await claimPost(db, basePost);
    await markFailed(db, {
      id: claim.row!.id,
      errorMessage: 'unsupported media',
      permanent: true,
      maxRetryAttempts: 5,
    });

    const row = (await db.select().from(processedPosts).where(eq(processedPosts.id, claim.row!.id)))[0];
    expect(row?.status).toBe('skipped');
    expect(row?.retryCount).toBe(0);
  });

  it('reclaims a row whose processing lease has expired', async () => {
    const claim = await claimPost(db, basePost);

    // Simulate a function killed mid-run 30 minutes ago.
    await db
      .update(processedPosts)
      .set({ lockedAt: new Date(Date.now() - 30 * 60 * 1000) })
      .where(eq(processedPosts.id, claim.row!.id));

    const reclaimed = await claimPost(db, basePost);
    expect(reclaimed.claimed).toBe(true);
  });

  it('does not reclaim a row whose lease is still fresh', async () => {
    await claimPost(db, basePost);
    const second = await claimPost(db, basePost);
    expect(second.claimed).toBe(false);
    expect(second.reason).toBe('in-flight');
  });
});

describeIfDb('published records', () => {
  it('stores every album message id', async () => {
    const claim = await claimPost(db, basePost);

    await markPublished(db, {
      id: claim.row!.id,
      telegramChatId: '-1001234567890',
      primaryMessageId: 100,
      telegramMethod: 'sendMediaGroup',
      mediaCount: 4,
      messages: [
        { messageId: 100, mediaIndex: 0, kind: 'media' },
        { messageId: 101, mediaIndex: 1, kind: 'media' },
        { messageId: 102, mediaIndex: 2, kind: 'media' },
        { messageId: 103, mediaIndex: 3, kind: 'media' },
      ],
    });

    const rows = await db
      .select()
      .from(telegramMessages)
      .where(eq(telegramMessages.processedPostId, claim.row!.id));

    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.telegramMessageId).sort()).toEqual([100, 101, 102, 103]);

    const post = (await db.select().from(processedPosts).where(eq(processedPosts.id, claim.row!.id)))[0];
    expect(post?.status).toBe('published');
    expect(post?.telegramMessageId).toBe(100);
    expect(post?.processedAt).toBeInstanceOf(Date);
  });

  it('reports terminal post ids so settled posts are not reprocessed', async () => {
    const published = await claimPost(db, basePost);
    await markPublished(db, {
      id: published.row!.id,
      telegramChatId: '-100',
      primaryMessageId: 1,
      telegramMethod: 'sendPhoto',
      mediaCount: 1,
      messages: [],
    });

    const skipped = await claimPost(db, { ...basePost, xPostId: '1750000000000000002' });
    await markSkipped(db, { id: skipped.row!.id, reason: 'too large' });

    const pending = await claimPost(db, { ...basePost, xPostId: '1750000000000000003' });
    expect(pending.claimed).toBe(true);

    const terminal = await findTerminalPostIds(db, [
      '1750000000000000001',
      '1750000000000000002',
      '1750000000000000003',
    ]);

    expect(terminal.has('1750000000000000001')).toBe(true);
    expect(terminal.has('1750000000000000002')).toBe(true);
    expect(terminal.has('1750000000000000003')).toBe(false);
  });

  it('counts posts by status', async () => {
    const a = await claimPost(db, basePost);
    await markPublished(db, {
      id: a.row!.id,
      telegramChatId: '-100',
      primaryMessageId: 1,
      telegramMethod: 'sendPhoto',
      mediaCount: 1,
      messages: [],
    });

    const b = await claimPost(db, { ...basePost, xPostId: '1750000000000000002' });
    await markSkipped(db, { id: b.row!.id, reason: 'no media' });

    const counts = await getStatusCounts(db);
    expect(counts.published).toBe(1);
    expect(counts.skipped).toBe(1);
    expect(counts.failed).toBe(0);
  });
});

describeIfDb('sync state cursor', () => {
  it('creates then updates a single row per source', async () => {
    await upsertSyncState(db, { source: 'x:123', lastSeenPostId: '100', lastSyncAt: new Date() });
    await upsertSyncState(db, { source: 'x:123', lastSeenPostId: '200' });

    const state = await getSyncState(db, 'x:123');
    expect(state?.lastSeenPostId).toBe('200');
    expect(await db.select().from(syncState)).toHaveLength(1);
  });

  it('preserves the cursor when updating only the error field', async () => {
    await upsertSyncState(db, { source: 'x:123', lastSeenPostId: '100' });
    await upsertSyncState(db, { source: 'x:123', lastError: 'X API unreachable' });

    const state = await getSyncState(db, 'x:123');
    expect(state?.lastSeenPostId).toBe('100');
    expect(state?.lastError).toBe('X API unreachable');
  });
});

describeIfDb('advisory lock', () => {
  it('derives a stable, positive 32-bit key', () => {
    const key = advisoryLockKey('content-arbitrary:sync');
    expect(key).toBe(advisoryLockKey('content-arbitrary:sync'));
    expect(key).toBeGreaterThan(0);
    expect(key).toBeLessThanOrEqual(0x7fffffff);
    expect(Number.isInteger(key)).toBe(true);
  });

  it('grants the lock to one holder and refuses the second', async () => {
    const first = await acquireSyncLock(sql, 'test:lock');
    expect(first.acquired).toBe(true);

    const second = await acquireSyncLock(sql, 'test:lock');
    expect(second.acquired).toBe(false);

    await first.release();

    // Once released, the next runner can take it.
    const third = await acquireSyncLock(sql, 'test:lock');
    expect(third.acquired).toBe(true);
    await third.release();
  });

  it('does not block on an unrelated lock name', async () => {
    const a = await acquireSyncLock(sql, 'test:lock-a');
    const b = await acquireSyncLock(sql, 'test:lock-b');

    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);

    await a.release();
    await b.release();
  });

  /**
   * Regression test for a deadlock that hung the very first sync run.
   *
   * The advisory lock reserves one connection for the whole run. With a pool of
   * a single connection there is then nothing left to run queries on, so every
   * subsequent statement waits forever. Both halves are asserted: that one
   * connection genuinely starves, and that the app's pool size does not.
   */
  async function queryCompletesWhileLockHeld(poolMax: number): Promise<boolean> {
    const pool = postgres(connectionString!, { max: poolMax, prepare: false });

    try {
      const lock = await acquireSyncLock(pool, `test:starvation-${poolMax}`);
      expect(lock.acquired).toBe(true);

      const completed = await Promise.race([
        pool`SELECT 1 AS ok`.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
      ]);

      if (completed) await lock.release();
      return completed;
    } finally {
      // end({ timeout }) so a pool with a blocked query still tears down.
      await pool.end({ timeout: 1 });
    }
  }

  it('starves queries when the pool holds only one connection', async () => {
    expect(await queryCompletesWhileLockHeld(1)).toBe(false);
  }, 15_000);

  it('leaves a connection free for queries at the pool size the app uses', async () => {
    expect(await queryCompletesWhileLockHeld(2)).toBe(true);
  }, 15_000);

  it('is safe to release twice', async () => {
    const lock = await acquireSyncLock(sql, 'test:lock-idem');
    await lock.release();
    await expect(lock.release()).resolves.toBeUndefined();
  });
});
