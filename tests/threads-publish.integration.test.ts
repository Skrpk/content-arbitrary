import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import {
  DEFAULT_WORKSPACE_ID,
  postDeliveries,
  processedPosts,
  sources,
  syncState,
  telegramMessages,
  threadsAccounts,
  workspaces,
} from '@/db/schema';
import { POST } from '@/app/api/telegram/webhook/route';
import { TelegramClient } from '@/lib/telegram/client';
import { publishDueScheduledPosts } from '@/lib/sync/publish-scheduled';
import { schedulePost } from '@/lib/sync/repository';
import { DELIVERY_MAX_ATTEMPTS } from '@/lib/threads/deliveries';
import { runThreadsDeliveries, type MediaHost } from '@/lib/threads/publisher';
import { encryptToken } from '@/lib/threads/token-crypto';
import { createTestLogger, ensureTestWorkspace, telegramOk, withEnv } from './helpers';

/**
 * A post approved for Threads, end to end: the review buttons through the
 * webhook route, the post settled and its delivery written, then the worker
 * taking it to a stand-in for Threads — container, wait, publish — with only
 * the Bot API, Threads' Graph API and the Blob store stubbed out.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

const SECRET = 'a'.repeat(64);
const BOT_TOKEN = '123456:AAHfakeTokenForTestsOnly';
const REVIEWER_ID = 555001;
const CHANNEL_CHAT = '-1001000000001';
const APP_SECRET = 'threads-app-secret-for-tests-0123456789';
const THREADS_USER = '17841405793187218';

const routeEnv = {
  DATABASE_URL: connectionString,
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_CHAT_ID: CHANNEL_CHAT,
  TELEGRAM_ADMIN_CHAT_ID: String(REVIEWER_ID),
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  REQUIRE_APPROVAL: 'true',
  APP_BASE_URL: 'https://example.vercel.app',
  WEB_APP_URL: 'https://app.example.com',
  THREADS_APP_ID: '4645779255666888',
  THREADS_APP_SECRET: APP_SECRET,
};

let telegram: { method: string; body: Record<string, unknown> }[];
let graph: { method: string; path: string; params: Record<string, string> }[];
/** What Threads says of a container, one answer per look; the last repeats. */
let statuses: string[];
let hosted: string[];
let removed: string[];

const host: MediaHost = {
  put: async (path) => {
    const url = `https://blob.test/${path}`;
    hosted.push(url);
    return url;
  },
  del: async (urls) => {
    removed.push(...urls);
  },
};

function stubNetwork() {
  telegram = [];
  graph = [];
  statuses = ['FINISHED'];
  hosted = [];
  removed = [];
  let containers = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

      if (url.hostname === 'graph.threads.com') {
        const params = Object.fromEntries(init?.body instanceof URLSearchParams ? init.body : url.searchParams);
        graph.push({ method: init?.method ?? 'GET', path: url.pathname, params });
        if (url.pathname.endsWith('/threads')) return json({ id: String(5000 + ++containers) });
        if (url.pathname.endsWith('/threads_publish')) return json({ id: '9001' });
        if (params.fields === 'status,error_message') {
          const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
          return json({ status, ...(status === 'ERROR' ? { error_message: 'Media download failed' } : {}) });
        }
        if (params.fields === 'permalink') return json({ permalink: 'https://www.threads.com/@zmistik/post/abc' });
        return new Response('not stubbed', { status: 500 });
      }

      if (url.pathname.startsWith(`/file/bot${BOT_TOKEN}/`)) {
        return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } });
      }
      const method = url.pathname.split('/').pop()!;
      const body = init?.body instanceof FormData ? {} : (JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      telegram.push({ method, body });
      if (method === 'getFile') return telegramOk({ file_id: 'FILE_A', file_path: 'photos/file_1.jpg' });
      if (method === 'sendPhoto') return telegramOk({ message_id: 900, chat: { id: -1 }, photo: [{ file_id: 'ONE', file_size: 1 }] });
      if (method === 'sendMessage') return telegramOk({ message_id: 901, chat: { id: -1 } });
      return telegramOk(true);
    }),
  );
}

const telegramTo = (method: string) => telegram.filter((call) => call.method === method);

function press(data: string) {
  return withEnv(routeEnv, () =>
    POST(
      new Request('https://example.vercel.app/api/telegram/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
        body: JSON.stringify({
          update_id: 1,
          callback_query: { id: 'cb-1', from: { id: REVIEWER_ID }, data, message: { message_id: 12, chat: { id: REVIEWER_ID } } },
        }),
      }),
    ),
  );
}

async function queuePost(options: { caption?: string; textOnly?: boolean } = {}) {
  const caption = options.caption ?? '<b>Webb</b> finds water';
  const [row] = await db
    .insert(processedPosts)
    .values({
      workspaceId: DEFAULT_WORKSPACE_ID,
      externalId: String(1_750_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1e6))),
      xPostUrl: 'https://x.com/someone/status/1750000000000000001',
      xAuthorUsername: 'someone',
      status: 'awaiting_approval',
      adminChatId: String(REVIEWER_ID),
      adminMessageId: 12,
      approvalPayload: options.textOnly
        ? { method: 'sendMessage', caption, items: [] }
        : { method: 'sendPhoto', caption, items: [{ kind: 'photo', fileId: 'FILE_A' }] },
      originalCaption: caption,
      caption,
    })
    .returning();
  return row!;
}

async function connectThreads() {
  await db.insert(threadsAccounts).values({
    workspaceId: DEFAULT_WORKSPACE_ID,
    threadsUserId: THREADS_USER,
    username: 'zmistik',
    accessTokenEncrypted: encryptToken('long-token', APP_SECRET),
    tokenExpiresAt: new Date(Date.now() + 50 * 24 * 3600 * 1000),
    tokenRefreshedAt: new Date(),
    scopes: ['threads_basic', 'threads_content_publish'],
  });
}

/** One worker run, as the cron makes it — at `at`, when given. */
function work(options: { at?: Date } = {}) {
  return withEnv(routeEnv, (env) =>
    runThreadsDeliveries({
      db,
      env,
      client: new TelegramClient({ token: BOT_TOKEN, baseUrl: 'https://api.telegram.org', attempts: 1 }),
      logger: createTestLogger(),
      host,
      sleep: async () => {},
      pollBudgetMs: 0,
      ...(options.at ? { now: () => options.at! } : {}),
    }),
  );
}

const reload = async (id: number) => (await db.select().from(processedPosts).where(eq(processedPosts.id, id)))[0]!;
const deliveryOf = async (postId: number) => (await db.select().from(postDeliveries).where(eq(postDeliveries.processedPostId, postId)))[0];

beforeAll(() => {
  if (!connectionString) return;
  sql = postgres(connectionString, { max: 4, prepare: false });
  db = drizzle(sql, { schema });
});

afterAll(async () => {
  if (sql) await sql.end();
  await (globalThis as { __contentArbitrarySql?: postgres.Sql }).__contentArbitrarySql?.end();
});

beforeEach(async () => {
  if (!connectionString) return;
  stubNetwork();
  await db.delete(postDeliveries);
  await db.delete(telegramMessages);
  await db.delete(processedPosts);
  await db.delete(syncState);
  await db.delete(sources);
  await ensureTestWorkspace(db);
  await db
    .update(workspaces)
    .set({ telegramChatId: CHANNEL_CHAT, telegramAdminChatId: String(REVIEWER_ID) })
    .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (connectionString) await db.delete(threadsAccounts);
});

describeIfDb('Approve to both', () => {
  it('publishes to the channel now, and to Threads once the worker runs', async () => {
    await connectThreads();
    const post = await queuePost({ textOnly: true });

    expect((await press(`ab:${post.id}`)).status).toBe(200);
    expect(telegramTo('sendMessage').some((call) => call.body.chat_id === CHANNEL_CHAT)).toBe(true);
    const settled = await reload(post.id);
    expect(settled).toMatchObject({ status: 'published', publishTargets: ['telegram', 'threads'], approvalPayload: null });
    expect(JSON.stringify(telegramTo('editMessageText'))).toContain('Threads: on its way');

    const delivery = await deliveryOf(post.id);
    expect(delivery).toMatchObject({ status: 'pending', platform: 'threads' });
    expect(delivery!.content).toMatchObject({ text: 'Webb finds water', media: [] });

    expect(await work()).toMatchObject({ published: 1 });
    const create = graph.find((call) => call.path === `/v1.0/${THREADS_USER}/threads`);
    expect(create?.params).toMatchObject({ media_type: 'TEXT', text: 'Webb finds water', access_token: 'long-token' });
    expect(await deliveryOf(post.id)).toMatchObject({
      status: 'published',
      externalId: '9001',
      url: 'https://www.threads.com/@zmistik/post/abc',
      error: null,
    });
  });

  it('carries a long text whole as a text attachment', async () => {
    await connectThreads();
    const long = Array.from({ length: 40 }, (_, i) => `Sentence ${i} about the telescope and its findings.`).join(' ');
    const post = await queuePost({ textOnly: true, caption: long });
    await press(`ab:${post.id}`);
    await work();
    const create = graph.find((call) => call.path === `/v1.0/${THREADS_USER}/threads`)!;
    expect(create.params.text!.length).toBeLessThanOrEqual(500);
    expect(JSON.parse(create.params.text_attachment!)).toEqual({ plaintext: long });
  });
});

describeIfDb('Approve to Threads alone', () => {
  it('settles the post without touching the channel, and takes its picture to Threads through the Blob store', async () => {
    await connectThreads();
    const post = await queuePost();

    await press(`ah:${post.id}`);
    expect(telegramTo('sendPhoto').filter((call) => call.body.chat_id === CHANNEL_CHAT)).toHaveLength(0);
    expect(await reload(post.id)).toMatchObject({ status: 'published', publishTargets: ['threads'], telegramMethod: 'none' });

    // Threads still processing the picture: left for the next run.
    statuses = ['IN_PROGRESS', 'FINISHED'];
    expect(await work()).toMatchObject({ waiting: 1 });
    expect(telegramTo('getFile')).toHaveLength(1);
    expect(hosted).toHaveLength(1);
    const create = graph.find((call) => call.path === `/v1.0/${THREADS_USER}/threads`)!;
    expect(create.params).toMatchObject({ media_type: 'IMAGE', image_url: hosted[0], text: 'Webb finds water' });
    expect(await deliveryOf(post.id)).toMatchObject({ status: 'processing', containerId: '5001' });

    // Not due again for half a minute; then published, and the copy deleted.
    expect(await work()).toMatchObject({ published: 0, waiting: 0 });
    expect(await work({ at: new Date(Date.now() + 31_000) })).toMatchObject({ published: 1 });
    expect(graph.filter((call) => call.path.endsWith('/threads'))).toHaveLength(1);
    expect(removed).toEqual(hosted);
    expect(await deliveryOf(post.id)).toMatchObject({ status: 'published', hostedUrls: [] });
  });

  it('is refused for a channel with no Threads account', async () => {
    const post = await queuePost();
    await press(`ah:${post.id}`);
    expect(JSON.stringify(telegramTo('answerCallbackQuery'))).toContain('Threads is not connected');
    expect(await reload(post.id)).toMatchObject({ status: 'awaiting_approval' });
    expect(await deliveryOf(post.id)).toBeUndefined();
  });
});

describeIfDb('a delivery Threads keeps failing', () => {
  it('is tried again later, then given up on, cleaned up, and the reviewer told', async () => {
    await connectThreads();
    const post = await queuePost();
    await press(`ah:${post.id}`);
    statuses = ['ERROR'];

    let at = Date.now();
    for (let attempt = 1; attempt < DELIVERY_MAX_ATTEMPTS; attempt += 1) {
      expect(await work({ at: new Date(at) })).toMatchObject({ retrying: 1 });
      at += 16 * 60_000;
    }
    expect(await work({ at: new Date(at) })).toMatchObject({ failed: 1 });

    const delivery = await deliveryOf(post.id);
    expect(delivery).toMatchObject({ status: 'failed', attempts: DELIVERY_MAX_ATTEMPTS, hostedUrls: [] });
    expect(delivery!.error).toContain('Media download failed');
    expect(new Set(removed)).toEqual(new Set(hosted));
    const notice = telegramTo('sendMessage').find((call) => String(call.body.text).includes('Not published to Threads'));
    expect(notice?.body.chat_id).toBe(String(REVIEWER_ID));
  });

  it('is given up on at once when the channel’s Threads account is gone', async () => {
    await connectThreads();
    const post = await queuePost({ textOnly: true });
    await press(`ah:${post.id}`);
    await db.delete(threadsAccounts);
    expect(await work()).toMatchObject({ failed: 1 });
    expect((await deliveryOf(post.id))!.error).toContain('not connected');
  });
});

describeIfDb('a post scheduled for Threads', () => {
  it('goes where it was scheduled for when its time comes', async () => {
    await connectThreads();
    const post = await queuePost();
    await schedulePost(db, {
      id: post.id,
      workspaceId: DEFAULT_WORKSPACE_ID,
      scheduledFor: new Date(Date.now() + 60_000),
      timezone: 'UTC',
      publishTargets: ['threads'],
    });

    const summary = await withEnv(routeEnv, (env) =>
      publishDueScheduledPosts({
        db,
        env,
        client: new TelegramClient({ token: BOT_TOKEN, baseUrl: 'https://api.telegram.org', attempts: 1 }),
        logger: createTestLogger(),
        now: new Date(Date.now() + 120_000),
        sleep: async () => {},
      }),
    );
    expect(summary).toMatchObject({ published: 1 });
    expect(telegramTo('sendPhoto').filter((call) => call.body.chat_id === CHANNEL_CHAT)).toHaveLength(0);
    expect(await deliveryOf(post.id)).toMatchObject({ status: 'pending' });
  });
});
