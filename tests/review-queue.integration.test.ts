import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
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
  workspaces,
  type ApprovalPayload,
} from '@/db/schema';
import { GET as loadQueueRoute, POST as decideRoute } from '@/app/api/telegram/webapp/queue/route';
import { POST as channelsRoute } from '@/app/api/telegram/webapp/channels/route';
import { syncPosts } from '@/lib/sync/sync-posts';
import { publishDueScheduledPosts } from '@/lib/sync/publish-scheduled';
import { schedulePost } from '@/lib/sync/repository';
import { dispatchCommand } from '@/lib/telegram/commands';
import { TelegramClient } from '@/lib/telegram/client';
import { XClient } from '@/lib/x/client';
import { createTestLogger, ensureTestWorkspace, instantSleep, POSTED_AT, silentLogger, withEnv } from './helpers';

/**
 * The review queue end to end: a sync run collects posts there instead of
 * sending them to the chat, a notification with a button to the page goes out
 * at most once per interval and only for something new, and a post is
 * approved — its media fetched again — or rejected from the page.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

const BOT_TOKEN = '123456:AAHfakeTokenForTestsOnly';
const REVIEWER_ID = 555001;
const ADMIN_CHAT = String(REVIEWER_ID);
const CHANNEL_CHAT = '-1003906212630';
const OTHER_WORKSPACE = 2;
const OTHER_REVIEWER_ID = 777002;
const MINUTE = 60 * 1000;

const queueEnv = {
  DATABASE_URL: connectionString,
  DRY_RUN: 'false',
  REQUIRE_APPROVAL: 'true',
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_ADMIN_CHAT_ID: ADMIN_CHAT,
  TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(64),
  TELEGRAM_CHAT_ID: CHANNEL_CHAT,
  APP_BASE_URL: 'https://example.vercel.app',
};

function timelinePayload(id: string, mediaKeys: string[]) {
  return {
    data: [
      {
        id,
        text: `Bear by the lake ${id.slice(-2)}`,
        created_at: POSTED_AT,
        author_id: '999',
        attachments: { media_keys: mediaKeys },
      },
    ],
    includes: {
      users: [{ id: '999', username: 'Trail_Cams' }],
      media: mediaKeys.map((key) => ({
        media_key: key,
        type: 'photo',
        url: `https://cdn.example/${key}.jpg`,
        width: 1600,
        height: 1200,
      })),
    },
    meta: { result_count: 1, newest_id: id },
  };
}

function makeXClient(payload: unknown) {
  return new XClient({
    bearerToken: 'fake',
    baseUrl: 'https://api.x.example',
    fetchImpl: vi.fn(async () =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }),
    ) as unknown as typeof fetch,
    attempts: 1,
  });
}

/** Telegram and the CDN in one: every Telegram call is recorded; media URLs answer with a small JPEG. */
function makeStack(options: { cdnStatus?: number } = {}) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let nextMessageId = 100;

  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes('/bot')) {
      if (options.cdnStatus && options.cdnStatus !== 200) return new Response('gone', { status: options.cdnStatus });
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, ...new Array(253).fill(0)]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': '256' },
      });
    }

    const method = url.split('/').pop()!;
    const raw = init?.body;
    const body = (
      typeof raw === 'string' ? JSON.parse(raw) : Object.fromEntries((raw as FormData).entries())
    ) as Record<string, unknown>;
    calls.push({ method, body });

    const ok = (result: unknown) =>
      new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const chat = { id: Number(body.chat_id) };
    if (method === 'sendMediaGroup') {
      return ok([
        { message_id: nextMessageId++, chat, photo: [{ file_id: 'FILE_A', file_size: 900 }] },
        { message_id: nextMessageId++, chat, photo: [{ file_id: 'FILE_B', file_size: 900 }] },
      ]);
    }
    if (method === 'sendPhoto') {
      return ok({ message_id: nextMessageId++, chat, photo: [{ file_id: 'ONE', file_size: 900 }] });
    }
    if (method === 'sendMessage') return ok({ message_id: nextMessageId++, chat });
    return ok(true);
  });

  const client = new TelegramClient({
    token: BOT_TOKEN,
    baseUrl: 'https://api.telegram.example',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    attempts: 1,
    sleep: instantSleep,
  });

  return { client, fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function runSync(
  stack: ReturnType<typeof makeStack>,
  payload: unknown,
  at?: number,
  envOverrides: Record<string, string | undefined> = {},
) {
  const logger = createTestLogger();
  return withEnv({ ...queueEnv, ...envOverrides }, (env) =>
    syncPosts({
      db,
      env,
      xClient: makeXClient(payload),
      telegramClient: stack.client,
      fetchImpl: stack.fetchImpl,
      logger,
      sleep: instantSleep,
      skipLock: true,
      ...(at === undefined ? {} : { now: () => at }),
    }),
  );
}

function initDataFor(userId: number): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId }),
  };
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const params = new URLSearchParams(fields);
  params.set('hash', createHmac('sha256', secretKey).update(dataCheckString).digest('hex'));
  return params.toString();
}

const auth = (userId = REVIEWER_ID) => `tma ${initDataFor(userId)}`;

function loadQueue(authorization = auth()) {
  return withEnv(queueEnv, () =>
    loadQueueRoute(new Request('https://example.vercel.app/api/telegram/webapp/queue', { headers: { authorization } })),
  );
}

function decide(body: unknown, authorization = auth()) {
  return withEnv(queueEnv, () =>
    decideRoute(
      new Request('https://example.vercel.app/api/telegram/webapp/queue', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization },
        body: JSON.stringify(body),
      }),
    ),
  );
}

function setInterval(body: unknown, authorization = auth()) {
  return withEnv(queueEnv, () =>
    channelsRoute(
      new Request('https://example.vercel.app/api/telegram/webapp/channels', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization },
        body: JSON.stringify(body),
      }),
    ),
  );
}

const QUEUED_PAYLOAD: ApprovalPayload = {
  method: 'sendPhoto',
  caption: 'Bear by the lake',
  items: [],
  sourceMedia: [{ mediaKey: '3_1', kind: 'photo', url: 'https://cdn.example/3_1.jpg', width: 1600, height: 1200 }],
};

let postSeq = 0;

/** A post in the queue, as a sync run leaves one. */
async function queuedPost(overrides: Partial<typeof processedPosts.$inferInsert> = {}) {
  postSeq += 1;
  const rows = await db
    .insert(processedPosts)
    .values({
      workspaceId: DEFAULT_WORKSPACE_ID,
      xPostId: String(1_750_000_000_000_000_000n + BigInt(postSeq)),
      xPostUrl: `https://x.com/trail_cams/status/${postSeq}`,
      xAuthorUsername: 'trail_cams',
      status: 'awaiting_approval',
      approvalPayload: QUEUED_PAYLOAD,
      reviewMedia: [{ kind: 'photo', url: 'https://cdn.example/3_1.jpg' }],
      reviewQueuedAt: new Date(),
      originalCaption: 'Bear by the lake',
      caption: 'Bear by the lake',
      ...overrides,
    })
    .returning();
  return rows[0]!;
}

async function score(processedPostId: number, value: number) {
  await db.insert(radarEvaluations).values({
    workspaceId: DEFAULT_WORKSPACE_ID,
    processedPostId,
    mode: 'live',
    variant: 'text',
    status: 'ok',
    model: 'gpt-6-luna',
    promptVersion: 'radar-v3-retrieval-approved',
    score: value,
    predictedDecision: value >= 50 ? 'approve' : 'reject',
    reason: `scored ${value}`,
  });
}

async function reload(id: number) {
  return (await db.select().from(processedPosts).where(eq(processedPosts.id, id)))[0]!;
}

async function workspaceRow(id = DEFAULT_WORKSPACE_ID) {
  return (await db.select().from(workspaces).where(eq(workspaces.id, id)))[0]!;
}

beforeAll(async () => {
  if (!connectionString) return;
  sql = postgres(connectionString, { max: 6, prepare: false });
  db = drizzle(sql, { schema });
});

afterAll(async () => {
  if (sql) await sql.end();
  await (globalThis as { __contentArbitrarySql?: postgres.Sql }).__contentArbitrarySql?.end();
});

beforeEach(async () => {
  if (!connectionString) return;
  await db.delete(telegramMessages);
  await db.delete(processedPosts);
  await db.delete(syncState);
  await db.delete(sources);
  await ensureTestWorkspace(db);
  await db
    .update(workspaces)
    .set({ telegramChatId: CHANNEL_CHAT, telegramAdminChatId: ADMIN_CHAT })
    .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describeIfDb('a sync run with the review queue on', () => {
  it('collects the post in the queue, sending nothing of it, and announces it with a button to the page', async () => {
    const stack = makeStack();
    const summary = await runSync(stack, timelinePayload('1750000000000000042', ['3_1', '3_2']));

    expect(summary.awaitingApproval).toBe(1);

    const row = (await db.select().from(processedPosts))[0]!;
    expect(row.status).toBe('awaiting_approval');
    expect(row.adminChatId).toBeNull();
    expect(row.adminMessageId).toBeNull();
    expect(row.reviewQueuedAt).toBeInstanceOf(Date);
    expect(row.mediaCount).toBe(2);
    expect(row.approvalPayload).toMatchObject({ method: 'sendMediaGroup', items: [] });
    expect(row.approvalPayload!.sourceMedia!.map((media) => media.url)).toEqual([
      'https://cdn.example/3_1.jpg',
      'https://cdn.example/3_2.jpg',
    ]);
    expect(row.reviewMedia).toEqual([
      { kind: 'photo', url: 'https://cdn.example/3_1.jpg' },
      { kind: 'photo', url: 'https://cdn.example/3_2.jpg' },
    ]);

    // One message only: the notification. No album, no buttons per post.
    expect(stack.calls.map((call) => call.method)).toEqual(['sendMessage']);
    const notice = stack.calls[0]!.body;
    expect(notice.chat_id).toBe(ADMIN_CHAT);
    expect(notice.text).toContain('1 post</b> new for review');
    expect(notice.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: '📋 Open review queue', web_app: { url: 'https://example.vercel.app/queue?workspace=1' } }],
      ],
    });

    const workspace = await workspaceRow();
    expect(workspace.reviewDigestSentAt).toBeInstanceOf(Date);
    expect(workspace.reviewDigestMessageId).toBe(100);
  });

  it('announces again only once the interval has passed, replacing the last notification', async () => {
    const stack = makeStack();
    const start = Date.now();
    await runSync(stack, timelinePayload('1750000000000000042', ['3_1']), start);

    // A new post twenty minutes later: queued, not announced.
    stack.calls.length = 0;
    await runSync(stack, timelinePayload('1750000000000000043', ['3_2']), start + 20 * MINUTE);
    expect(stack.calls).toEqual([]);
    expect(await db.select().from(processedPosts)).toHaveLength(2);

    // An hour on, a few seconds early, as cron runs start: announced, and the old one deleted.
    await runSync(stack, timelinePayload('1750000000000000043', ['3_2']), start + 60 * MINUTE - 5_000);
    expect(stack.calls.map((call) => call.method)).toEqual(['sendMessage', 'deleteMessage']);
    expect(stack.calls[0]!.body.text).toContain('1 post</b> new for review · 2 waiting in all');
    expect(stack.calls[1]!.body).toMatchObject({ chat_id: ADMIN_CHAT, message_id: 100 });
    expect((await workspaceRow()).reviewDigestMessageId).toBe(101);
  });

  it('sends nothing when the interval has passed but nothing new came in', async () => {
    const stack = makeStack();
    const start = Date.now();
    await runSync(stack, timelinePayload('1750000000000000042', ['3_1']), start);

    stack.calls.length = 0;
    await runSync(stack, timelinePayload('1750000000000000042', ['3_1']), start + 3 * 60 * MINUTE);
    expect(stack.calls).toEqual([]);
  });

  it('sends each post to the chat with its buttons, as before, when the channel asks for that', async () => {
    await db.update(workspaces).set({ reviewDigestMinutes: null }).where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
    const stack = makeStack();
    await runSync(stack, timelinePayload('1750000000000000042', ['3_1']));

    expect(stack.calls.map((call) => call.method)).toEqual(['sendPhoto', 'sendMessage']);
    const row = (await db.select().from(processedPosts))[0]!;
    expect(row.adminMessageId).toBe(101);
    expect(row.reviewQueuedAt).toBeNull();
    expect(row.approvalPayload?.items.map((item) => item.fileId)).toEqual(['ONE']);
  });

  it('sends posts to the chat when there is no Mini App to hold the queue', async () => {
    const stack = makeStack();
    await runSync(stack, timelinePayload('1750000000000000042', ['3_1']), undefined, { APP_BASE_URL: undefined });

    expect(stack.calls.map((call) => call.method)).toEqual(['sendPhoto', 'sendMessage']);
  });
});

describeIfDb('GET /api/telegram/webapp/queue', () => {
  it('lists every waiting post, best Radar score first, unscored ones last', async () => {
    const low = await queuedPost();
    const unscored = await queuedPost({ caption: 'No score here', originalCaption: 'No score here' });
    const high = await queuedPost();
    await score(low.id, 31);
    await score(high.id, 88);
    await queuedPost({ status: 'rejected', rejectionReason: 'too_minor' });

    const response = await loadQueue();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      channels: { id: number; waiting: number; items: { id: number; score: { score: number } | null; text: string; media: unknown }[] }[];
    };

    const [channel] = body.channels;
    expect(channel!.waiting).toBe(3);
    expect(channel!.items.map((item) => item.id)).toEqual([high.id, low.id, unscored.id]);
    expect(channel!.items[0]).toMatchObject({
      score: { score: 88, predictedDecision: 'approve', reason: 'scored 88' },
      text: 'Bear by the lake',
      media: [{ kind: 'photo', imageUrl: 'https://cdn.example/3_1.jpg' }],
    });
    expect(channel!.items[2]!.score).toBeNull();
  });

  it('shows the text without the channel footer', async () => {
    await db
      .update(workspaces)
      .set({ postFooter: '[Bears](https://t.me/bears)' })
      .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
    await queuedPost({ caption: 'Bear\n\n<a href="https://t.me/bears">Bears</a>' });

    const body = (await (await loadQueue()).json()) as { channels: { items: { text: string }[] }[] };
    expect(body.channels[0]!.items[0]!.text).toBe('Bear');
  });

  it('refuses a validly signed user who reviews for nobody', async () => {
    expect((await loadQueue(auth(424242))).status).toBe(401);
  });
});

describeIfDb('POST /api/telegram/webapp/queue', () => {
  it('approves: fetches the media again and publishes to the channel', async () => {
    const stack = makeStack();
    vi.stubGlobal('fetch', stack.fetchImpl);
    const post = await queuedPost();

    const response = await decide({ action: 'approve', postId: post.id });

    expect(response.status).toBe(200);
    expect(stack.calls.map((call) => [call.method, call.body.chat_id])).toEqual([['sendPhoto', CHANNEL_CHAT]]);
    const row = await reload(post.id);
    expect(row.status).toBe('published');
    expect(row.reviewedAt).toBeInstanceOf(Date);
    expect(row.mediaCount).toBe(1);
  });

  it('leaves the post in the queue when its media can no longer be fetched', async () => {
    const stack = makeStack({ cdnStatus: 404 });
    vi.stubGlobal('fetch', stack.fetchImpl);
    const post = await queuedPost();

    const response = await decide({ action: 'approve', postId: post.id });

    expect(response.status).toBe(502);
    expect(stack.calls).toEqual([]);
    const row = await reload(post.id);
    expect(row.status).toBe('awaiting_approval');
    expect(row.errorMessage).toBeTruthy();
  });

  it('settles the chat message too, for a post that is also there', async () => {
    const stack = makeStack();
    vi.stubGlobal('fetch', stack.fetchImpl);
    const post = await queuedPost({
      adminChatId: ADMIN_CHAT,
      adminMessageId: 77,
      reviewQueuedAt: null,
      approvalPayload: { method: 'sendPhoto', caption: 'Bear', items: [{ kind: 'photo', fileId: 'F' }] },
    });

    expect((await decide({ action: 'approve', postId: post.id })).status).toBe(200);
    // Sent from Telegram's copy — no download — then the buttons in the chat replaced.
    expect(stack.calls.map((call) => call.method)).toEqual(['sendPhoto', 'editMessageText']);
    expect(stack.calls[0]!.body.photo).toBe('F');
    expect(stack.calls[1]!.body).toMatchObject({ chat_id: ADMIN_CHAT, message_id: 77 });
  });

  it('rejects with a reason, and with the reviewer’s own words for "other"', async () => {
    vi.stubGlobal('fetch', makeStack().fetchImpl);
    const first = await queuedPost();
    const second = await queuedPost();

    expect((await decide({ action: 'reject', postId: first.id, reason: 'wrong_topic' })).status).toBe(200);
    expect((await decide({ action: 'reject', postId: second.id, reason: 'other', note: '  Old news  ' })).status).toBe(200);

    expect(await reload(first.id)).toMatchObject({ status: 'rejected', rejectionReason: 'wrong_topic', rejectionNote: null });
    expect(await reload(second.id)).toMatchObject({ status: 'rejected', rejectionReason: 'other', rejectionNote: 'Old news' });
  });

  it('answers a post already decided, or another channel’s, as no longer waiting', async () => {
    vi.stubGlobal('fetch', makeStack().fetchImpl);
    await db.insert(workspaces).values({
      id: OTHER_WORKSPACE,
      name: 'second',
      telegramChatId: '-1002000000002',
      telegramAdminChatId: String(OTHER_REVIEWER_ID),
    });
    const theirs = await queuedPost({ workspaceId: OTHER_WORKSPACE });
    const decided = await queuedPost({ status: 'rejected', rejectionReason: 'too_minor' });

    expect((await decide({ action: 'approve', postId: theirs.id })).status).toBe(409);
    expect((await decide({ action: 'reject', postId: decided.id, reason: 'too_minor' })).status).toBe(409);
    expect((await reload(theirs.id)).status).toBe('awaiting_approval');
  });

  it('refuses an unknown reason before it reaches the database', async () => {
    const post = await queuedPost();
    expect((await decide({ action: 'reject', postId: post.id, reason: 'boring' })).status).toBe(400);
  });
});

describeIfDb('a queued post scheduled for later', () => {
  it('is published by the scheduler from its stored media', async () => {
    const stack = makeStack();
    const post = await queuedPost();
    await schedulePost(db, {
      id: post.id,
      workspaceId: DEFAULT_WORKSPACE_ID,
      scheduledFor: new Date(Date.now() - MINUTE),
      timezone: 'UTC',
    });

    const summary = await withEnv(queueEnv, (env) =>
      publishDueScheduledPosts({
        db,
        env,
        client: stack.client,
        logger: silentLogger,
        sleep: instantSleep,
        fetchImpl: stack.fetchImpl,
      }),
    );

    expect(summary.published).toBe(1);
    expect(stack.calls.map((call) => [call.method, call.body.chat_id])).toEqual([['sendPhoto', CHANNEL_CHAT]]);
    expect((await reload(post.id)).status).toBe('published');
  });
});

describeIfDb('POST /api/telegram/webapp/channels', () => {
  it('sets how often the queue is announced, or turns it off for the chat', async () => {
    const hourly = await setInterval({ workspaceId: DEFAULT_WORKSPACE_ID, reviewDigestMinutes: 180 });
    expect(await hourly.json()).toEqual({ id: DEFAULT_WORKSPACE_ID, reviewDigestMinutes: 180, queueActive: true });

    const chat = await setInterval({ workspaceId: DEFAULT_WORKSPACE_ID, reviewDigestMinutes: null });
    expect(await chat.json()).toMatchObject({ reviewDigestMinutes: null, queueActive: false });
    expect((await workspaceRow()).reviewDigestMinutes).toBeNull();
  });

  it('refuses an interval outside one cron run to ninety days, and another reviewer’s channel', async () => {
    await db.insert(workspaces).values({
      id: OTHER_WORKSPACE,
      name: 'second',
      telegramChatId: '-1002000000002',
      telegramAdminChatId: String(OTHER_REVIEWER_ID),
    });

    expect((await setInterval({ workspaceId: DEFAULT_WORKSPACE_ID, reviewDigestMinutes: 5 })).status).toBe(400);
    expect((await setInterval({ workspaceId: DEFAULT_WORKSPACE_ID, reviewDigestMinutes: 200_000 })).status).toBe(400);
    expect((await setInterval({ workspaceId: OTHER_WORKSPACE, reviewDigestMinutes: 60 })).status).toBe(404);
    expect((await workspaceRow(OTHER_WORKSPACE)).reviewDigestMinutes).toBe(60);
  });
});

describeIfDb('/review', () => {
  it('counts what is waiting and offers the queue', async () => {
    await queuedPost();
    await queuedPost();
    await queuedPost({ status: 'published' });

    const reply = await dispatchCommand(
      {
        db,
        xClient: makeXClient({}),
        logger: createTestLogger(),
        workspaceId: DEFAULT_WORKSPACE_ID,
      },
      { command: 'review', args: '' },
    );

    expect(reply).toEqual({ text: '📥 <b>2 posts</b> waiting for review', offerQueue: true });
  });
});
