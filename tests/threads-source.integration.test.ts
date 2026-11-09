import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import {
  DEFAULT_WORKSPACE_ID,
  processedPosts,
  radarEvaluations,
  sources,
  syncState,
  telegramMessages,
  threadsAccounts,
  workspaces,
} from '@/db/schema';
import { addThreadsSource, NOT_A_READABLE_PROFILE } from '@/lib/sources/add-threads';
import { refreshSourceMedia } from '@/lib/sources/refresh-media';
import { syncPosts } from '@/lib/sync/sync-posts';
import { TelegramClient } from '@/lib/telegram/client';
import { NO_THREADS_READER, ThreadsReadBudget, threadsReaderFor, threadsReading } from '@/lib/threads/reader';
import { encryptToken } from '@/lib/threads/token-crypto';
import { XClient } from '@/lib/x/client';
import { createTestLogger, ensureTestWorkspace, instantSleep, withEnv } from './helpers';

/**
 * Threads accounts as sources, through the whole pipeline, against a real
 * database: Threads' Graph API and the Bot API are stubbed; reading accounts,
 * sources, cursors, the run's request budget and the review queue are real.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

const APP_SECRET = 'threads-app-secret-for-tests-0123456789';
const OTHER_WORKSPACE = 2;

const threadsEnv = {
  DATABASE_URL: connectionString,
  DRY_RUN: 'false',
  REQUIRE_APPROVAL: 'true',
  TELEGRAM_ADMIN_CHAT_ID: '555001',
  TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(64),
  TELEGRAM_CHAT_ID: '-1003906212630',
  MAX_POSTS_PER_RUN: '5',
  APP_BASE_URL: 'https://radar.example',
  WEB_APP_URL: 'https://app.example.com',
  THREADS_APP_ID: '4645779255666888',
  THREADS_APP_SECRET: APP_SECRET,
  THREADS_READER_USERNAME: '@Zmistik_Reader',
};

/** What the stand-in for Threads has to say. */
const threads = {
  profiles: new Set<string>(),
  posts: new Map<string, Record<string, unknown>[]>(),
  requests: [] as URL[],
};

const graphFetch = vi.fn(async (input: unknown) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  // The posts' pictures themselves, as Threads' CDN serves them.
  if (url.hostname === 'scontent.example') {
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { 'content-type': 'image/jpeg', 'content-length': '4' } });
  }
  threads.requests.push(url);
  const username = url.searchParams.get('username') ?? '';
  if (url.pathname === '/v1.0/profile_lookup') {
    return threads.profiles.has(username)
      ? Response.json({ username, name: `The ${username}`, follower_count: 5000 })
      : Response.json({ error: { message: 'Profile not found' } }, { status: 400 });
  }
  if (url.pathname === '/v1.0/profile_posts') return Response.json({ data: threads.posts.get(username) ?? [] });
  const single = /^\/v1\.0\/(\d+)$/.exec(url.pathname);
  if (single) {
    return Response.json({ id: single[1], media_type: 'IMAGE', media_url: `https://scontent.example/fresh-${single[1]}.jpg` });
  }
  return Response.json({ error: { message: 'not stubbed' } }, { status: 500 });
}) as unknown as typeof fetch;

const tokenOf = (url: URL) => url.searchParams.get('access_token');

async function connect(input: { workspaceId: number; username: string; token: string; scopes?: string[] }) {
  await db.insert(threadsAccounts).values({
    workspaceId: input.workspaceId,
    threadsUserId: String(Math.floor(Math.random() * 1e12)),
    username: input.username,
    accessTokenEncrypted: encryptToken(input.token, APP_SECRET),
    tokenExpiresAt: new Date(Date.now() + 50 * 24 * 3600 * 1000),
    tokenRefreshedAt: new Date(),
    scopes: input.scopes ?? ['threads_basic', 'threads_content_publish', 'threads_profile_discovery'],
  });
}

function bot() {
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const body = (typeof init?.body === 'string' ? JSON.parse(init.body) : {}) as Record<string, unknown>;
    return Response.json({ ok: true, result: { message_id: 700, chat: { id: Number(body.chat_id) } }, method: String(input) });
  });
  return new TelegramClient({ token: '123456:TEST', baseUrl: 'https://api.telegram.example', fetchImpl: fetchImpl as unknown as typeof fetch, attempts: 1, sleep: instantSleep });
}

const unusedX = () =>
  new XClient({
    bearerToken: 'fake',
    baseUrl: 'https://api.x.example',
    fetchImpl: vi.fn(async () => {
      throw new Error('X should not be called');
    }) as unknown as typeof fetch,
    attempts: 1,
  });

function sync(budget = new ThreadsReadBudget()) {
  return withEnv(threadsEnv, (env) =>
    syncPosts({
      db,
      env,
      xClient: unusedX(),
      telegramClient: bot(),
      youtubeClient: null,
      transcriptProvider: null,
      threads: { reading: threadsReading(env), budget, fetchImpl: graphFetch },
      logger: createTestLogger(),
      sleep: instantSleep,
      skipLock: true,
      translationProvider: null,
      imageUnderstander: null,
    }),
  );
}

function add(account: string, workspaceId = DEFAULT_WORKSPACE_ID) {
  return withEnv(threadsEnv, (env) => addThreadsSource(db, { account, workspaceId, reading: threadsReading(env), fetchImpl: graphFetch }));
}

const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString().replace('Z', '+0000');

beforeAll(() => {
  if (!connectionString) return;
  sql = postgres(connectionString, { max: 8, prepare: false });
  db = drizzle(sql, { schema });
});

afterAll(async () => {
  if (sql) await sql.end();
  await (globalThis as { __contentArbitrarySql?: postgres.Sql }).__contentArbitrarySql?.end();
});

beforeEach(async () => {
  if (!connectionString) return;
  await db.delete(radarEvaluations);
  await db.delete(telegramMessages);
  await db.delete(processedPosts);
  await db.delete(syncState);
  await db.delete(sources);
  await ensureTestWorkspace(db);
  await db
    .update(workspaces)
    .set({ telegramChatId: '-1003906212630', telegramAdminChatId: '555001' })
    .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
  await db.insert(workspaces).values({ id: OTHER_WORKSPACE, name: 'Other', telegramChatId: '-1003906212631', telegramAdminChatId: '555002' });
  threads.profiles = new Set(['nasa', 'esa', 'spacex']);
  threads.posts.clear();
  threads.requests.length = 0;
  // Whatever else the pipeline fetches — a post's picture — goes to the stand-in too.
  vi.stubGlobal('fetch', graphFetch);
  // The shared reader, connected on another channel than the one it reads for.
  await connect({ workspaceId: OTHER_WORKSPACE, username: 'zmistik_reader', token: 'shared-token' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describeIfDb('adding a Threads account', () => {
  it('looks the profile up with the reading account, and stores it by its username', async () => {
    const result = await add('https://www.threads.com/@NASA');
    expect(result).toMatchObject({ ok: true, created: true, username: 'nasa', name: 'The nasa' });
    const [source] = await db.select().from(sources);
    expect(source).toMatchObject({ platform: 'threads', externalId: 'nasa', username: 'nasa' });
    expect(tokenOf(threads.requests[0]!)).toBe('shared-token');
  });

  it('turns away an account Threads will not show', async () => {
    expect(await add('@someone_private')).toEqual({ ok: false, reason: NOT_A_READABLE_PROFILE });
    expect(await db.select().from(sources)).toHaveLength(0);
  });

  it('says so when no account can read', async () => {
    await db.delete(threadsAccounts);
    expect(await add('@nasa')).toEqual({ ok: false, reason: NO_THREADS_READER });
  });
});

describeIfDb('syncing a Threads account', () => {
  it('brings its new posts with media to review, and remembers how far it got', async () => {
    await add('@nasa');
    const newest = inMinutes(3);
    threads.posts.set('nasa', [
      { id: '103', media_type: 'IMAGE', media_url: 'https://scontent.example/c.jpg', text: 'Third', timestamp: newest, permalink: 'https://www.threads.com/@nasa/post/C', username: 'nasa' },
      { id: '102', media_type: 'REPOST_FACADE', timestamp: inMinutes(2), username: 'nasa' },
      { id: '101', media_type: 'TEXT_POST', text: 'Text only', timestamp: inMinutes(1), username: 'nasa' },
      { id: '100', media_type: 'IMAGE', media_url: 'https://scontent.example/a.jpg', text: 'Old', timestamp: inMinutes(-60 * 24), username: 'nasa' },
    ]);

    const summary = await sync();
    expect(summary.sources[0]).toMatchObject({ platform: 'threads', checked: 4, skipped: 3, newPosts: 1, awaitingApproval: 1 });
    const [post] = await db.select().from(processedPosts);
    expect(post).toMatchObject({ externalId: 'th:103', status: 'awaiting_approval', xAuthorUsername: 'nasa', xPostUrl: 'https://www.threads.com/@nasa/post/C' });
    expect(post!.approvalPayload?.sourceMedia?.[0]).toMatchObject({ kind: 'photo', url: 'https://scontent.example/c.jpg' });

    const read = threads.requests.find((url) => url.pathname === '/v1.0/profile_posts')!;
    expect(read.searchParams.get('username')).toBe('nasa');
    expect(tokenOf(read)).toBe('shared-token');

    // The next run asks only for what came after the newest post it saw.
    threads.requests.length = 0;
    await sync();
    const next = threads.requests.find((url) => url.pathname === '/v1.0/profile_posts')!;
    expect(Number(next.searchParams.get('since'))).toBe(Math.floor(new Date(newest.replace('+0000', 'Z')).getTime() / 1000));
    expect(await db.select().from(processedPosts)).toHaveLength(1);
  });

  it('reads no more accounts a run than the reading account’s share, and the ones left wait their turn', async () => {
    for (const name of ['nasa', 'esa', 'spacex']) await add(`@${name}`);

    const first = await sync(new ThreadsReadBudget(2));
    expect(threads.requests.filter((url) => url.pathname === '/v1.0/profile_posts')).toHaveLength(2);
    const waited = first.sources.find((source) => source.deferred)!;
    expect(first.sources.filter((source) => source.deferred)).toHaveLength(1);
    const [state] = await db.select().from(syncState).where(and(eq(syncState.workspaceId, DEFAULT_WORKSPACE_ID), eq(syncState.source, `threads:${waited.externalId}`)));
    expect(state?.lastSyncAt ?? null).toBeNull();

    threads.requests.length = 0;
    await sync(new ThreadsReadBudget(1));
    expect(threads.requests.find((url) => url.pathname === '/v1.0/profile_posts')!.searchParams.get('username')).toBe(waited.externalId);
  });

  it('fails the source, and says why, when no account can read', async () => {
    await add('@nasa');
    await db.delete(threadsAccounts);
    const summary = await sync();
    expect(summary.sources[0]!.error).toContain(NO_THREADS_READER);
  });
});

describeIfDb('who reads for a channel', () => {
  it('is the shared account, unless the channel’s own may read and the mode prefers it', async () => {
    await connect({ workspaceId: DEFAULT_WORKSPACE_ID, username: 'channel_own', token: 'own-token' });
    const shared = await withEnv(threadsEnv, (env) => threadsReaderFor(db, threadsReading(env)!, DEFAULT_WORKSPACE_ID));
    expect(shared?.token).toBe('shared-token');

    const own = await withEnv({ ...threadsEnv, THREADS_READER_MODE: 'own_first' }, (env) =>
      threadsReaderFor(db, threadsReading(env)!, DEFAULT_WORKSPACE_ID),
    );
    expect(own?.token).toBe('own-token');
  });

  it('is the shared account when the channel’s own never granted profile discovery', async () => {
    await connect({ workspaceId: DEFAULT_WORKSPACE_ID, username: 'channel_own', token: 'own-token', scopes: ['threads_basic', 'threads_content_publish'] });
    const reader = await withEnv({ ...threadsEnv, THREADS_READER_MODE: 'own_first' }, (env) =>
      threadsReaderFor(db, threadsReading(env)!, DEFAULT_WORKSPACE_ID),
    );
    expect(reader?.token).toBe('shared-token');
  });
});

describeIfDb('a queued Threads post’s media', () => {
  it('are looked up afresh before they are fetched, for their links expire', async () => {
    const fresh = await withEnv(threadsEnv, (env) =>
      refreshSourceMedia('th:555', [{ mediaKey: 'th:555:0', kind: 'photo', url: 'https://scontent.example/stale.jpg' }], {
        db,
        env,
        workspaceId: DEFAULT_WORKSPACE_ID,
        fetchImpl: graphFetch,
      }),
    );
    expect(fresh).toEqual([{ mediaKey: 'th:555:0', kind: 'photo', url: 'https://scontent.example/fresh-555.jpg' }]);
  });
});
