import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import { processedPosts, syncState, telegramMessages } from '@/db/schema';
import { syncPosts } from '@/lib/sync/sync-posts';
import { XClient } from '@/lib/x/client';
import { TelegramClient } from '@/lib/telegram/client';
import { getSyncState } from '@/lib/sync/repository';
import { createTestLogger, instantSleep, telegramError, telegramOk, withEnv } from './helpers';

/**
 * End-to-end exercise of one sync cycle: X responses and Telegram responses are
 * stubbed, but the database is real, so ordering, idempotency and state
 * transitions are genuinely verified.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

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

const photoMedia = (key: string) => ({
  media_key: key,
  type: 'photo',
  url: `https://pbs.twimg.com/media/${key}.jpg`,
  width: 1200,
  height: 800,
});

function timeline(posts: { id: string; text?: string; mediaKeys: string[] }[]) {
  return {
    data: posts.map((post) => ({
      id: post.id,
      text: post.text ?? `post ${post.id}`,
      created_at: '2026-01-15T10:00:00.000Z',
      attachments: { media_keys: post.mediaKeys },
    })),
    includes: {
      media: [...new Set(posts.flatMap((p) => p.mediaKeys))].map(photoMedia),
    },
    meta: {
      result_count: posts.length,
      newest_id: posts[0]?.id,
      oldest_id: posts[posts.length - 1]?.id,
    },
  };
}

function makeXClient(payload: unknown) {
  return new XClient({
    bearerToken: 'test',
    baseUrl: 'https://api.x.example',
    fetchImpl: vi.fn(async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch,
    attempts: 1,
  });
}

/** Telegram + media CDN stub. `failFor` makes specific posts fail. */
function makeTelegramStub(options?: { failFor?: (callIndex: number) => Response | null }) {
  let messageId = 1000;
  let telegramCalls = 0;

  const fetchImpl = vi.fn(async (input: unknown) => {
    const url = String(input);

    if (url.includes('api.telegram.example')) {
      telegramCalls += 1;
      const override = options?.failFor?.(telegramCalls);
      if (override) return override;

      messageId += 1;
      const method = url.split('/').pop()!;
      return method === 'sendMediaGroup'
        ? telegramOk([{ message_id: messageId, chat: { id: -1001234567890 } }])
        : telegramOk({ message_id: messageId, chat: { id: -1001234567890 } });
    }

    return new Response(new Uint8Array(256), {
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': '256' },
    });
  });

  const client = new TelegramClient({
    token: '123456:TEST',
    baseUrl: 'https://api.telegram.example',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    attempts: 2,
    sleep: instantSleep,
  });

  return { client, fetchImpl, getTelegramCalls: () => telegramCalls };
}

describeIfDb('syncPosts end to end', () => {
  it('publishes new media posts and records them', async () => {
    const xClient = makeXClient(
      timeline([
        { id: '1750000000000000003', mediaKeys: ['3_c'] },
        { id: '1750000000000000002', mediaKeys: ['3_b1', '3_b2'] },
        { id: '1750000000000000001', mediaKeys: ['3_a'] },
      ]),
    );
    const { client, fetchImpl } = makeTelegramStub();

    const summary = await withEnv({ DRY_RUN: 'false' }, (env) =>
      syncPosts({
        db,
        env,
        xClient,
        telegramClient: client,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        logger: createTestLogger(),
        sleep: instantSleep,
        skipLock: true,
      }),
    );

    expect(summary.checked).toBe(3);
    expect(summary.newPosts).toBe(3);
    expect(summary.published).toBe(3);
    expect(summary.failed).toBe(0);

    const rows = await db.select().from(processedPosts);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === 'published')).toBe(true);
  });

  it('publishes oldest first so the channel keeps the original order', async () => {
    const published: string[] = [];

    const xClient = makeXClient(
      timeline([
        { id: '1750000000000000003', mediaKeys: ['3_c'] },
        { id: '1750000000000000002', mediaKeys: ['3_b'] },
        { id: '1750000000000000001', mediaKeys: ['3_a'] },
      ]),
    );

    const { client, fetchImpl } = makeTelegramStub();
    fetchImpl.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('api.telegram.example')) {
        const form = init!.body as FormData;
        published.push(String(form.get('caption')));
        return telegramOk({ message_id: published.length, chat: { id: -100 } });
      }
      return new Response(new Uint8Array(8), {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': '8' },
      });
    });

    await withEnv({ DRY_RUN: 'false' }, (env) =>
      syncPosts({
        db,
        env,
        xClient,
        telegramClient: client,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        logger: createTestLogger(),
        sleep: instantSleep,
        skipLock: true,
      }),
    );

    expect(published[0]).toContain('post 1750000000000000001');
    expect(published[1]).toContain('post 1750000000000000002');
    expect(published[2]).toContain('post 1750000000000000003');
  });

  it('does not republish on a second run', async () => {
    const payload = timeline([
      { id: '1750000000000000002', mediaKeys: ['3_b'] },
      { id: '1750000000000000001', mediaKeys: ['3_a'] },
    ]);

    const first = makeTelegramStub();
    const firstSummary = await withEnv({ DRY_RUN: 'false' }, (env) =>
      syncPosts({
        db,
        env,
        xClient: makeXClient(payload),
        telegramClient: first.client,
        fetchImpl: first.fetchImpl as unknown as typeof fetch,
        logger: createTestLogger(),
        sleep: instantSleep,
        skipLock: true,
      }),
    );

    expect(firstSummary.published).toBe(2);

    // X returns the same posts again (e.g. the cursor did not advance).
    const second = makeTelegramStub();
    const secondSummary = await withEnv({ DRY_RUN: 'false' }, (env) =>
      syncPosts({
        db,
        env,
        xClient: makeXClient(payload),
        telegramClient: second.client,
        fetchImpl: second.fetchImpl as unknown as typeof fetch,
        logger: createTestLogger(),
        sleep: instantSleep,
        skipLock: true,
      }),
    );

    expect(secondSummary.published).toBe(0);
    expect(secondSummary.skipped).toBe(2);
    expect(second.getTelegramCalls()).toBe(0);
    expect(await db.select().from(processedPosts)).toHaveLength(2);
  });

  it('keeps publishing after one post fails (A published, B failed, C published)', async () => {
    const xClient = makeXClient(
      timeline([
        { id: '1750000000000000003', mediaKeys: ['3_c'] },
        { id: '1750000000000000002', mediaKeys: ['3_b'] },
        { id: '1750000000000000001', mediaKeys: ['3_a'] },
      ]),
    );

    // The second post's Telegram call fails permanently; both retries of it
    // return the same error, and the third post must still go out.
    const { client, fetchImpl } = makeTelegramStub({
      failFor: (callIndex) =>
        callIndex === 2 ? telegramError(400, 'Bad Request: IMAGE_PROCESS_FAILED') : null,
    });

    const summary = await withEnv({ DRY_RUN: 'false' }, (env) =>
      syncPosts({
        db,
        env,
        xClient,
        telegramClient: client,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        logger: createTestLogger(),
        sleep: instantSleep,
        skipLock: true,
      }),
    );

    expect(summary.published).toBe(2);
    expect(summary.skipped).toBeGreaterThanOrEqual(1);

    const rows = await db.select().from(processedPosts);
    const byId = new Map(rows.map((r) => [r.xPostId, r]));

    expect(byId.get('1750000000000000001')?.status).toBe('published');
    expect(byId.get('1750000000000000002')?.status).toBe('skipped');
    expect(byId.get('1750000000000000003')?.status).toBe('published');
    expect(byId.get('1750000000000000002')?.errorMessage).toContain('IMAGE_PROCESS_FAILED');
  });

  it('advances the cursor only when nothing failed', async () => {
    const xClient = makeXClient(timeline([{ id: '1750000000000000009', mediaKeys: ['3_a'] }]));
    const { client, fetchImpl } = makeTelegramStub();

    await withEnv({ DRY_RUN: 'false' }, (env) =>
      syncPosts({
        db,
        env,
        xClient,
        telegramClient: client,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        logger: createTestLogger(),
        sleep: instantSleep,
        skipLock: true,
      }),
    );

    const state = await getSyncState(db, 'x:1234567890');
    expect(state?.lastSeenPostId).toBe('1750000000000000009');
    expect(state?.lastSuccessfulSyncAt).toBeInstanceOf(Date);
  });

  it('does not advance the cursor when a post failed transiently', async () => {
    const xClient = makeXClient(timeline([{ id: '1750000000000000009', mediaKeys: ['3_a'] }]));
    const { client, fetchImpl } = makeTelegramStub({
      failFor: () => telegramError(503, 'Service Unavailable'),
    });

    const summary = await withEnv({ DRY_RUN: 'false' }, (env) =>
      syncPosts({
        db,
        env,
        xClient,
        telegramClient: client,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        logger: createTestLogger(),
        sleep: instantSleep,
        skipLock: true,
      }),
    );

    expect(summary.failed).toBe(1);

    // Leaving the cursor alone means the next run can pick the post up again.
    const state = await getSyncState(db, 'x:1234567890');
    expect(state?.lastSeenPostId).toBeNull();
  });

  it('respects MAX_POSTS_PER_RUN', async () => {
    const xClient = makeXClient(
      timeline(
        Array.from({ length: 8 }, (_, index) => ({
          id: `175000000000000000${index + 1}`,
          mediaKeys: [`3_${index}`],
        })),
      ),
    );
    const { client, fetchImpl } = makeTelegramStub();

    const summary = await withEnv({ DRY_RUN: 'false', MAX_POSTS_PER_RUN: '3' }, (env) =>
      syncPosts({
        db,
        env,
        xClient,
        telegramClient: client,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        logger: createTestLogger(),
        sleep: instantSleep,
        skipLock: true,
      }),
    );

    expect(summary.published).toBe(3);
    expect(await db.select().from(processedPosts)).toHaveLength(3);
  });

  it('does not skip past posts it did not reach when the batch is limited', async () => {
    // With MAX_POSTS_PER_RUN below the number of pending posts, the cursor must
    // not jump to the newest post in the window — the posts in between were
    // never claimed, so advancing past them would drop them permanently.
    const payload = timeline([
      { id: '1750000000000000003', mediaKeys: ['3_c'] },
      { id: '1750000000000000002', mediaKeys: ['3_b'] },
      { id: '1750000000000000001', mediaKeys: ['3_a'] },
    ]);

    const first = makeTelegramStub();
    await withEnv({ DRY_RUN: 'false', MAX_POSTS_PER_RUN: '1' }, (env) =>
      syncPosts({
        db,
        env,
        xClient: makeXClient(payload),
        telegramClient: first.client,
        fetchImpl: first.fetchImpl as unknown as typeof fetch,
        logger: createTestLogger(),
        sleep: instantSleep,
        skipLock: true,
      }),
    );

    const state = await getSyncState(db, 'x:1234567890');
    expect(state?.lastSeenPostId).toBe('1750000000000000001');

    // The next two runs must still deliver the remaining posts.
    for (let run = 0; run < 2; run += 1) {
      const stub = makeTelegramStub();
      await withEnv({ DRY_RUN: 'false', MAX_POSTS_PER_RUN: '1' }, (env) =>
        syncPosts({
          db,
          env,
          xClient: makeXClient(payload),
          telegramClient: stub.client,
          fetchImpl: stub.fetchImpl as unknown as typeof fetch,
          logger: createTestLogger(),
          sleep: instantSleep,
          skipLock: true,
        }),
      );
    }

    const published = await db.select().from(processedPosts);
    expect(published.map((r) => r.xPostId).sort()).toEqual([
      '1750000000000000001',
      '1750000000000000002',
      '1750000000000000003',
    ]);
    expect(published.every((r) => r.status === 'published')).toBe(true);
  });

  it('publishes nothing in DRY_RUN and leaves posts pending', async () => {
    const xClient = makeXClient(
      timeline([
        { id: '1750000000000000002', mediaKeys: ['3_b'] },
        { id: '1750000000000000001', mediaKeys: ['3_a'] },
      ]),
    );
    const { client, fetchImpl, getTelegramCalls } = makeTelegramStub();

    const summary = await withEnv({ DRY_RUN: 'true' }, (env) =>
      syncPosts({
        db,
        env,
        xClient,
        telegramClient: client,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        logger: createTestLogger(),
        sleep: instantSleep,
        skipLock: true,
      }),
    );

    expect(summary.dryRun).toBe(true);
    expect(getTelegramCalls()).toBe(0);

    const rows = await db.select().from(processedPosts);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);

    // The cursor must not move, or a real run would skip these posts.
    const state = await getSyncState(db, 'x:1234567890');
    expect(state?.lastSeenPostId).toBeNull();
  });

  it('publishes for real what a preceding dry run only previewed', async () => {
    const payload = timeline([{ id: '1750000000000000001', mediaKeys: ['3_a'] }]);

    const dry = makeTelegramStub();
    await withEnv({ DRY_RUN: 'true' }, (env) =>
      syncPosts({
        db,
        env,
        xClient: makeXClient(payload),
        telegramClient: dry.client,
        fetchImpl: dry.fetchImpl as unknown as typeof fetch,
        logger: createTestLogger(),
        sleep: instantSleep,
        skipLock: true,
      }),
    );

    const live = makeTelegramStub();
    const summary = await withEnv({ DRY_RUN: 'false' }, (env) =>
      syncPosts({
        db,
        env,
        xClient: makeXClient(payload),
        telegramClient: live.client,
        fetchImpl: live.fetchImpl as unknown as typeof fetch,
        logger: createTestLogger(),
        sleep: instantSleep,
        skipLock: true,
      }),
    );

    expect(summary.published).toBe(1);
    expect(live.getTelegramCalls()).toBeGreaterThan(0);
  });

  it('records an album\'s message ids against the post', async () => {
    const xClient = makeXClient(
      timeline([{ id: '1750000000000000001', mediaKeys: ['3_a', '3_b', '3_c', '3_d'] }]),
    );

    const { client, fetchImpl } = makeTelegramStub();
    fetchImpl.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes('api.telegram.example')) {
        return telegramOk([
          { message_id: 201, chat: { id: -100 } },
          { message_id: 202, chat: { id: -100 } },
          { message_id: 203, chat: { id: -100 } },
          { message_id: 204, chat: { id: -100 } },
        ]);
      }
      return new Response(new Uint8Array(8), {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': '8' },
      });
    });

    await withEnv({ DRY_RUN: 'false' }, (env) =>
      syncPosts({
        db,
        env,
        xClient,
        telegramClient: client,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        logger: createTestLogger(),
        sleep: instantSleep,
        skipLock: true,
      }),
    );

    const messages = await db.select().from(telegramMessages);
    expect(messages.map((m) => m.telegramMessageId).sort()).toEqual([201, 202, 203, 204]);

    const post = (await db.select().from(processedPosts))[0];
    expect(post?.telegramMethod).toBe('sendMediaGroup');
    expect(post?.telegramMessageId).toBe(201);
    expect(post?.mediaCount).toBe(4);
  });

  it('reports the X failure without throwing when the API is down', async () => {
    const xClient = new XClient({
      bearerToken: 'test',
      baseUrl: 'https://api.x.example',
      fetchImpl: vi.fn(async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch,
      attempts: 1,
    });

    const summary = await withEnv({ DRY_RUN: 'false' }, (env) =>
      syncPosts({
        db,
        env,
        xClient,
        telegramClient: makeTelegramStub().client,
        fetchImpl: makeTelegramStub().fetchImpl as unknown as typeof fetch,
        logger: createTestLogger(),
        sleep: instantSleep,
        skipLock: true,
      }),
    );

    expect(summary.error).toMatch(/401/);
    expect(summary.published).toBe(0);
  });

  it('two concurrent runs publish each post exactly once', async () => {
    const payload = timeline([
      { id: '1750000000000000002', mediaKeys: ['3_b'] },
      { id: '1750000000000000001', mediaKeys: ['3_a'] },
    ]);

    const runA = makeTelegramStub();
    const runB = makeTelegramStub();

    // Both runs bypass the advisory lock, leaving only the per-post atomic
    // claim to prevent duplicates — the worst case we must survive.
    const [a, b] = await Promise.all([
      withEnv({ DRY_RUN: 'false' }, (env) =>
        syncPosts({
          db,
          env,
          xClient: makeXClient(payload),
          telegramClient: runA.client,
          fetchImpl: runA.fetchImpl as unknown as typeof fetch,
          logger: createTestLogger(),
          sleep: instantSleep,
          skipLock: true,
        }),
      ),
      withEnv({ DRY_RUN: 'false' }, (env) =>
        syncPosts({
          db,
          env,
          xClient: makeXClient(payload),
          telegramClient: runB.client,
          fetchImpl: runB.fetchImpl as unknown as typeof fetch,
          logger: createTestLogger(),
          sleep: instantSleep,
          skipLock: true,
        }),
      ),
    ]);

    // Exactly two posts exist, and exactly two Telegram sends happened overall.
    expect(await db.select().from(processedPosts)).toHaveLength(2);
    expect(a.published + b.published).toBe(2);
    expect(runA.getTelegramCalls() + runB.getTelegramCalls()).toBe(2);
  });
});
