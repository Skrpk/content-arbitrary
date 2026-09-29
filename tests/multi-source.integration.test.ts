import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import { processedPosts, sources, syncState, telegramMessages } from '@/db/schema';
import { syncPosts } from '@/lib/sync/sync-posts';
import { addSource, listSources, setSourceEnabled } from '@/lib/sources/repository';
import { getSyncState, upsertSyncState } from '@/lib/sync/repository';
import { XClient } from '@/lib/x/client';
import { TelegramClient } from '@/lib/telegram/client';
import { createTestLogger, instantSleep, withEnv } from './helpers';

/**
 * The single-source → many-sources step: each account gets its own cursor, and
 * one broken account must not stop the others.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

const CHANNEL = '-1003906212630';

/** Posts keyed by the X user id the timeline belongs to. */
function timelineFor(userId: string, postIds: string[], username = `user${userId}`) {
  return {
    data: postIds.map((id) => ({
      id,
      text: `post ${id}`,
      created_at: '2026-01-15T12:00:00.000Z',
      author_id: userId,
      attachments: { media_keys: [`m_${id}`] },
    })),
    includes: {
      users: [{ id: userId, username }],
      media: postIds.map((id) => ({
        media_key: `m_${id}`,
        type: 'photo',
        url: `https://cdn.example/${id}.jpg`,
        width: 1200,
        height: 800,
      })),
    },
    meta: {
      result_count: postIds.length,
      newest_id: postIds[0],
      oldest_id: postIds[postIds.length - 1],
    },
  };
}

/**
 * X stub that answers per user id, and can be told to fail for one of them.
 * Records which user ids were actually fetched.
 */
function makeXStack(
  timelines: Record<string, string[]>,
  options?: { failFor?: string; usernames?: Record<string, string> },
) {
  const fetched: string[] = [];

  const fetchImpl = vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    const userId = url.pathname.split('/')[3]!;
    fetched.push(userId);

    if (options?.failFor === userId) {
      return new Response('upstream exploded', { status: 500 });
    }

    const payload = timelineFor(
      userId,
      timelines[userId] ?? [],
      options?.usernames?.[userId],
    );
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const client = new XClient({
    bearerToken: 'test',
    baseUrl: 'https://api.x.example',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    attempts: 1,
  });

  return { client, fetched };
}

function makeTelegramStack() {
  const sends: { method: string; chatId: unknown }[] = [];
  let messageId = 100;

  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);

    if (!url.includes('api.telegram.example')) {
      return new Response(new Uint8Array(128), {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': '128' },
      });
    }

    const method = url.split('/').pop()!;
    const raw = init?.body;
    const body = (
      typeof raw === 'string' ? JSON.parse(raw) : Object.fromEntries((raw as FormData).entries())
    ) as Record<string, unknown>;
    sends.push({ method, chatId: body.chat_id });

    messageId += 1;
    const result =
      method === 'sendMediaGroup'
        ? [{ message_id: messageId, chat: { id: 1 }, photo: [{ file_id: 'F', file_size: 9 }] }]
        : { message_id: messageId, chat: { id: 1 }, photo: [{ file_id: 'F', file_size: 9 }] };

    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const client = new TelegramClient({
    token: '123456:TEST',
    baseUrl: 'https://api.telegram.example',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    attempts: 1,
    sleep: instantSleep,
  });

  return { client, fetchImpl: fetchImpl as unknown as typeof fetch, sends };
}

beforeAll(async () => {
  if (!connectionString) return;
  sql = postgres(connectionString, { max: 6, prepare: false });
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
  await db.delete(sources);
});

const baseEnv = {
  DRY_RUN: 'false',
  REQUIRE_APPROVAL: 'false',
  TELEGRAM_CHAT_ID: CHANNEL,
  MAX_POSTS_PER_RUN: '5',
};

async function run(
  x: ReturnType<typeof makeXStack>,
  telegram: ReturnType<typeof makeTelegramStack>,
  env: Record<string, string | undefined> = {},
) {
  return withEnv({ ...baseEnv, ...env }, (parsed) =>
    syncPosts({
      db,
      env: parsed,
      xClient: x.client,
      telegramClient: telegram.client,
      fetchImpl: telegram.fetchImpl,
      logger: createTestLogger(),
      sleep: instantSleep,
      skipLock: true,
    }),
  );
}

describeIfDb('multi-source sync', () => {
  it('fetches every enabled source in one run', async () => {
    await addSource(db, { platform: 'x', externalId: '111', username: 'alpha' });
    await addSource(db, { platform: 'x', externalId: '222', username: 'beta' });

    const x = makeXStack(
      { '111': ['1750000000000000011'], '222': ['1750000000000000022'] },
      { usernames: { '111': 'alpha', '222': 'beta' } },
    );
    const telegram = makeTelegramStack();

    const summary = await run(x, telegram);

    expect(x.fetched.sort()).toEqual(['111', '222']);
    expect(summary.published).toBe(2);
    expect(summary.sources).toHaveLength(2);
    expect(summary.sources.map((source) => source.username).sort()).toEqual(['alpha', 'beta']);
  });

  it('gives each source its own cursor', async () => {
    await addSource(db, { platform: 'x', externalId: '111', username: 'alpha' });
    await addSource(db, { platform: 'x', externalId: '222', username: 'beta' });

    const x = makeXStack({ '111': ['1750000000000000011'], '222': ['1750000000000000022'] });
    await run(x, makeTelegramStack());

    expect((await getSyncState(db, 'x:111'))?.lastSeenPostId).toBe('1750000000000000011');
    expect((await getSyncState(db, 'x:222'))?.lastSeenPostId).toBe('1750000000000000022');
  });

  it('does not let one source\'s cursor affect another', async () => {
    await addSource(db, { platform: 'x', externalId: '111', username: 'alpha' });
    await addSource(db, { platform: 'x', externalId: '222', username: 'beta' });

    // alpha is already caught up; beta has never synced.
    await upsertSyncState(db, { source: 'x:111', lastSeenPostId: '1750000000000000011' });

    const x = makeXStack(
      { '111': [], '222': ['1750000000000000022'] },
      { usernames: { '111': 'alpha', '222': 'beta' } },
    );
    const telegram = makeTelegramStack();
    const summary = await run(x, telegram);

    const alpha = summary.sources.find((source) => source.username === 'alpha')!;
    const beta = summary.sources.find((source) => source.username === 'beta')!;

    expect(alpha.published).toBe(0);
    expect(beta.published).toBe(1);
    // alpha's cursor must not have moved backwards or been overwritten.
    expect((await getSyncState(db, 'x:111'))?.lastSeenPostId).toBe('1750000000000000011');
  });

  it('keeps processing other sources when one fails', async () => {
    await addSource(db, { platform: 'x', externalId: '111', username: 'broken' });
    await addSource(db, { platform: 'x', externalId: '222', username: 'healthy' });

    const x = makeXStack(
      { '111': ['1750000000000000011'], '222': ['1750000000000000022'] },
      { failFor: '111', usernames: { '111': 'broken', '222': 'healthy' } },
    );
    const telegram = makeTelegramStack();

    const summary = await run(x, telegram);

    const broken = summary.sources.find((source) => source.username === 'broken')!;
    const healthy = summary.sources.find((source) => source.username === 'healthy')!;

    expect(broken.error).toMatch(/500/);
    expect(broken.published).toBe(0);
    expect(healthy.published).toBe(1);

    // The run reports the failure without pretending everything was fine.
    expect(summary.error).toContain('@broken');
    expect(summary.published).toBe(1);
  });

  it('records the failing source\'s error against its own cursor row', async () => {
    await addSource(db, { platform: 'x', externalId: '111', username: 'broken' });

    const x = makeXStack({ '111': [] }, { failFor: '111' });
    await run(x, makeTelegramStack());

    const state = await getSyncState(db, 'x:111');
    expect(state?.lastError).toMatch(/500/);
    expect(state?.lastSeenPostId).toBeNull();
  });

  it('skips paused sources', async () => {
    const alpha = await addSource(db, { platform: 'x', externalId: '111', username: 'alpha' });
    await addSource(db, { platform: 'x', externalId: '222', username: 'beta' });
    await setSourceEnabled(db, { id: alpha.source.id, enabled: false });

    const x = makeXStack({ '111': ['1750000000000000011'], '222': ['1750000000000000022'] });
    const summary = await run(x, makeTelegramStack());

    expect(x.fetched).toEqual(['222']);
    expect(summary.sources).toHaveLength(1);
  });

  it('applies MAX_POSTS_PER_RUN to each source independently', async () => {
    await addSource(db, { platform: 'x', externalId: '111', username: 'alpha' });
    await addSource(db, { platform: 'x', externalId: '222', username: 'beta' });

    const x = makeXStack({
      '111': ['1750000000000000013', '1750000000000000012', '1750000000000000011'],
      '222': ['1750000000000000023', '1750000000000000022', '1750000000000000021'],
    });

    const summary = await run(x, makeTelegramStack(), { MAX_POSTS_PER_RUN: '2' });

    // Two from each, not two across both — a busy source cannot starve a quiet one.
    expect(summary.published).toBe(4);
    expect(summary.sources.every((source) => source.published === 2)).toBe(true);
  });

  it('does nothing and says so when there are no sources', async () => {
    const x = makeXStack({});
    const summary = await withEnv(
      { ...baseEnv, X_USER_ID: undefined, X_USERNAME: undefined },
      (env) =>
        syncPosts({
          db,
          env,
          xClient: x.client,
          telegramClient: makeTelegramStack().client,
          logger: createTestLogger(),
          sleep: instantSleep,
          skipLock: true,
        }),
    );

    expect(summary.sources).toHaveLength(0);
    expect(summary.published).toBe(0);
    expect(x.fetched).toHaveLength(0);
  });
});

describeIfDb('legacy env bootstrap', () => {
  it('imports the legacy account on the first run', async () => {
    const x = makeXStack({ '1234567890': [] });

    await run(x, makeTelegramStack(), { X_USER_ID: '1234567890', X_USERNAME: 'legacy' });

    const stored = await listSources(db);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ platform: 'x', externalId: '1234567890', enabled: true });
  });

  it('keeps an existing deployment publishing without any manual step', async () => {
    const x = makeXStack({ '1234567890': ['1750000000000000011'] });
    const telegram = makeTelegramStack();

    const summary = await run(x, telegram, { X_USER_ID: '1234567890', X_USERNAME: 'legacy' });

    expect(summary.published).toBe(1);
    expect(telegram.sends.some((send) => send.chatId === CHANNEL)).toBe(true);
  });

  it('does not import twice across runs', async () => {
    const env = { X_USER_ID: '1234567890', X_USERNAME: 'legacy' };

    await run(makeXStack({ '1234567890': [] }), makeTelegramStack(), env);
    await run(makeXStack({ '1234567890': [] }), makeTelegramStack(), env);

    expect(await listSources(db)).toHaveLength(1);
  });

  it('does not resurrect a source the admin deleted', async () => {
    const env = { X_USER_ID: '1234567890', X_USERNAME: 'legacy' };

    await run(makeXStack({ '1234567890': [] }), makeTelegramStack(), env);
    await db.delete(sources);

    // The cursor row left behind is what proves this account was imported once.
    await run(makeXStack({ '1234567890': [] }), makeTelegramStack(), env);

    expect(await listSources(db)).toHaveLength(0);
  });

  it('does not import when sources already exist', async () => {
    await addSource(db, { platform: 'x', externalId: '999', username: 'chosen' });

    const x = makeXStack({ '999': [] });
    await run(x, makeTelegramStack(), { X_USER_ID: '1234567890', X_USERNAME: 'legacy' });

    const stored = await listSources(db);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.externalId).toBe('999');
  });
});
