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
  stories,
  storyPosts,
  syncState,
  telegramMessages,
  users,
  workspaces,
  type ApprovalPayload,
} from '@/db/schema';
import { GET as loadQueueRoute, POST as decideRoute } from '@/app/api/telegram/webapp/queue/route';
import { POST as channelsRoute } from '@/app/api/telegram/webapp/channels/route';
import * as accountRoute from '@/app/api/account/route';
import * as richRoute from '@/app/api/telegram/webapp/rich/route';
import * as captionRoute from '@/app/api/telegram/webapp/caption/route';
import { loadRadarNote } from '@/lib/radar/review-note';
import { sendReviewDigest } from '@/lib/review/queue';
import { syncPosts } from '@/lib/sync/sync-posts';
import { publishDueScheduledPosts } from '@/lib/sync/publish-scheduled';
import { schedulePost } from '@/lib/sync/repository';
import { setReviewLink, userForTelegram } from '@/lib/accounts/users';
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
    if (method === 'sendMessage' || method === 'sendRichMessage') return ok({ message_id: nextMessageId++, chat });
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
      externalId: String(1_750_000_000_000_000_000n + BigInt(postSeq)),
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

/** Put posts in one story, as the clustering would. */
async function inOneStory(...postIds: number[]) {
  const [story] = await db.insert(stories).values({ workspaceId: DEFAULT_WORKSPACE_ID }).returning();
  await db.insert(storyPosts).values(
    postIds.map((processedPostId, index) => ({
      processedPostId,
      storyId: story!.id,
      nearestPostId: index === 0 ? null : postIds[0]!,
      similarity: index === 0 ? null : 0.8,
      threshold: 0.75,
      embeddingModel: 'text-embedding-3-small',
    })),
  );
  return story!.id;
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
  await db.delete(users);
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
    expect(notice.text).toContain('1 new post · 1 story · 0 recommended');
    expect(notice.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: '📋 Open review queue', web_app: { url: 'https://example.vercel.app/queue?workspace=1' } }],
      ],
    });

    const workspace = await workspaceRow();
    expect(workspace.reviewDigestSentAt).toBeInstanceOf(Date);
    expect(workspace.reviewDigestMessageId).toBe(100);
  });

  it('announces again only once the interval has passed, keeping the last notification in the chat', async () => {
    const stack = makeStack();
    const start = Date.now();
    await runSync(stack, timelinePayload('1750000000000000042', ['3_1']), start);

    // A new post twenty minutes later: queued, not announced.
    stack.calls.length = 0;
    await runSync(stack, timelinePayload('1750000000000000043', ['3_2']), start + 20 * MINUTE);
    expect(stack.calls).toEqual([]);
    expect(await db.select().from(processedPosts)).toHaveLength(2);

    // An hour on, a few seconds early, as cron runs start: announced — the post since the last one only.
    await runSync(stack, timelinePayload('1750000000000000043', ['3_2']), start + 60 * MINUTE - 5_000);
    expect(stack.calls.map((call) => call.method)).toEqual(['sendMessage']);
    expect(stack.calls[0]!.body.text).toContain('1 new post · 1 story');
    expect((await workspaceRow()).reviewDigestMessageId).toBe(101);
  });

  it('links to the website for a reviewer who chose to review there', async () => {
    const reviewer = await userForTelegram(db, { id: REVIEWER_ID });
    await setReviewLink(db, reviewer!.id, 'website');
    const stack = makeStack();
    await runSync(stack, timelinePayload('1750000000000000042', ['3_1']), undefined, {
      WEB_APP_URL: 'https://app.example.com',
    });

    expect(stack.calls[0]!.body.reply_markup).toEqual({
      inline_keyboard: [[{ text: '📋 Open review queue', url: 'https://app.example.com/queue?workspace=1' }]],
    });
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

  it('publishes straight to the channel for one that publishes without review, reviewer or not', async () => {
    await db
      .update(workspaces)
      .set({ autoPublish: true, telegramAdminChatId: null })
      .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
    const stack = makeStack();
    const summary = await runSync(stack, timelinePayload('1750000000000000042', ['3_1', '3_2']));

    expect(summary).toMatchObject({ published: 1, awaitingApproval: 0 });
    // The album in the channel, and nothing to a reviewer: no notification, no buttons.
    expect(stack.calls.map((call) => call.method)).toEqual(['sendMediaGroup']);
    expect(stack.calls[0]!.body.chat_id).toBe(CHANNEL_CHAT);
    const row = (await db.select().from(processedPosts))[0]!;
    expect(row).toMatchObject({ status: 'published', reviewQueuedAt: null, adminMessageId: null });
    expect((await workspaceRow()).reviewDigestSentAt).toBeNull();
  });
});

describeIfDb('the queue digest', () => {
  const digestEnv = { REQUIRE_APPROVAL: true, APP_BASE_URL: 'https://example.vercel.app', WEB_APP_URL: undefined };

  async function digest(now = new Date()) {
    const stack = makeStack();
    const outcome = await sendReviewDigest({
      db,
      env: digestEnv,
      client: stack.client,
      workspace: await workspaceRow(),
      now,
      logger: silentLogger,
    });
    return { outcome, calls: stack.calls };
  }

  it('lists a story once, with all its sources, and the recommended stories best first', async () => {
    const strong = await queuedPost({ xAuthorUsername: 'nasa', caption: 'Webb traced a record radio burst\n\nMore below' });
    const sameStory = await queuedPost({ xAuthorUsername: 'esa', caption: 'Record burst traced by Webb' });
    const decidedEarlier = await queuedPost({ status: 'rejected', rejectionReason: 'too_minor', xAuthorUsername: 'spacenews', caption: 'Webb burst' });
    const middling = await queuedPost({ xAuthorUsername: 'spacex', caption: 'Starship flies again' });
    const weak = await queuedPost({ xAuthorUsername: 'trail_cams', caption: 'A bear' });
    await score(strong.id, 91);
    await score(sameStory.id, 60);
    await score(middling.id, 72);
    await score(weak.id, 20);
    await inOneStory(decidedEarlier.id, strong.id, sameStory.id);

    const { outcome, calls } = await digest();

    expect(outcome).toMatchObject({ sent: true, recommended: 2, shown: 2 });
    const text = String(calls[0]!.body.text);
    expect(text).toContain('5 new posts · 3 stories · 2 recommended');
    expect(text).toContain('1. <b>91%</b> — Webb traced a record radio burst\n<i>scored 91</i>\nSources: @nasa, @esa, @spacenews');
    expect(text).toContain('2. <b>72%</b> — Starship flies again');
    expect(text).not.toContain('Record burst traced by Webb');
    expect(text).not.toContain('A bear');
    expect(calls[0]!.body.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: '1', web_app: { url: `https://example.vercel.app/queue?workspace=1&post=${strong.id}` } },
          { text: '2', web_app: { url: `https://example.vercel.app/queue?workspace=1&post=${middling.id}` } },
        ],
        [{ text: '📋 Open review queue', web_app: { url: 'https://example.vercel.app/queue?workspace=1' } }],
      ],
    });
    expect((await reload(strong.id)).digestSentAt).toBeInstanceOf(Date);
    expect((await reload(sameStory.id)).digestSentAt).toBeNull();
  });

  it('never recommends a story twice, even when a new post of it comes in, and shows at most five', async () => {
    const shown = await queuedPost({ caption: 'Already in a digest' });
    await score(shown.id, 95);
    await inOneStory(shown.id);
    const storyId = (await db.select().from(storyPosts).where(eq(storyPosts.processedPostId, shown.id)))[0]!.storyId;
    await digest(new Date(Date.now() - 2 * 60 * MINUTE));
    await db.update(workspaces).set({ reviewDigestSentAt: new Date(Date.now() - 2 * 60 * MINUTE) }).where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));

    // Later: another source on the same story, and seven new stories.
    const another = await queuedPost({ caption: 'The same, from elsewhere', reviewQueuedAt: new Date(Date.now() + 1000) });
    await score(another.id, 93);
    await db.insert(storyPosts).values({ processedPostId: another.id, storyId, threshold: 0.75, embeddingModel: 'text-embedding-3-small' });
    for (let i = 0; i < 7; i += 1) {
      const fresh = await queuedPost({ caption: `Story ${i}`, reviewQueuedAt: new Date(Date.now() + 1000) });
      await score(fresh.id, 80 - i);
    }

    const { outcome, calls } = await digest(new Date(Date.now() + 5000));
    const text = String(calls[0]!.body.text);
    expect(outcome).toMatchObject({ sent: true, recommended: 7, shown: 5 });
    expect(text).not.toContain('The same, from elsewhere');
    expect(text).toContain('1. <b>80%</b> — Story 0');
    expect(text).toContain('5. <b>76%</b> — Story 4');
    expect(text).toContain('2 more recommended in the queue.');
  });

  it('says so when nothing stands out, in the channel’s language', async () => {
    await db.update(workspaces).set({ language: 'uk' }).where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
    const weak = await queuedPost();
    await score(weak.id, 15);
    await queuedPost();

    const { outcome, calls } = await digest();

    expect(outcome).toMatchObject({ sent: true, recommended: 0, shown: 0 });
    expect(calls[0]!.body.text).toContain('2 нові пости · 2 історії · 0 рекомендованих');
    expect(calls[0]!.body.text).toContain('Сильних історій за цей період немає');
    expect(calls[0]!.body.reply_markup).toEqual({
      inline_keyboard: [[{ text: '📋 Відкрити чергу', web_app: { url: 'https://example.vercel.app/queue?workspace=1' } }]],
    });
  });

  it('sends nothing for a channel whose posts go to the chat one by one', async () => {
    await db.update(workspaces).set({ reviewDigestMinutes: null }).where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
    await queuedPost();
    const { outcome, calls } = await digest();
    expect(outcome).toEqual({ sent: false, reason: 'not-queued' });
    expect(calls).toEqual([]);
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

  it('marks a post its source sent before, with what became of the earlier copy', async () => {
    const earlier = await queuedPost({ status: 'rejected', rejectionReason: 'not_interesting', createdAt: new Date('2026-10-10T08:00:00Z') });
    const repeat = await queuedPost();
    const close = await queuedPost();
    const otherSource = await queuedPost({ xAuthorUsername: 'bears_daily' });
    const [story] = await db.insert(stories).values({ workspaceId: DEFAULT_WORKSPACE_ID }).returning();
    const placed = (processedPostId: number, similarity: number | null, nearestPostId: number | null = earlier.id) => ({
      processedPostId,
      storyId: story!.id,
      nearestPostId,
      similarity,
      threshold: 0.75,
      embeddingModel: 'text-embedding-3-small',
    });
    await db
      .insert(storyPosts)
      .values([placed(earlier.id, null, null), placed(repeat.id, 0.99), placed(close.id, 0.9), placed(otherSource.id, 0.99)]);

    type Item = { id: number; repeat: { arrivedAt: string; outcome: string } | null; alsoInStory: Item[] };
    const body = (await (await loadQueue()).json()) as { channels: { items: Item[] }[] };
    // One story, so one card: the repeat may lead it or sit under it.
    const posts = body.channels[0]!.items.flatMap((item) => [item, ...item.alsoInStory]);
    const repeatOf = (id: number) => posts.find((item) => item.id === id)!.repeat;
    expect(repeatOf(repeat.id)).toEqual({ arrivedAt: '2026-10-10T08:00:00.000Z', outcome: 'rejected' });
    expect(repeatOf(close.id)).toBeNull();
    expect(repeatOf(otherSource.id)).toBeNull();
    expect(await loadRadarNote(db, repeat.id)).toBe('🔁 Repeat of a post from 10 Oct · rejected');
  });

  it('shows a story as one card: its best-scored post, the others under it, and what the channel already has of it', async () => {
    const published = await queuedPost({ status: 'published', xAuthorUsername: 'esa', reviewedAt: new Date('2026-10-12T09:00:00Z') });
    const weaker = await queuedPost({ xAuthorUsername: 'spacex' });
    const alone = await queuedPost();
    const stronger = await queuedPost({ xAuthorUsername: 'nasa' });
    await score(weaker.id, 40);
    await score(alone.id, 60);
    await score(stronger.id, 80);
    await inOneStory(published.id, weaker.id, stronger.id);

    type Item = { id: number; alsoInStory: Item[]; storyPublished: { sourceLabel: string; approvedAt: string }[] };
    const body = (await (await loadQueue()).json()) as { channels: { waiting: number; items: Item[] }[] };
    const [channel] = body.channels;

    expect(channel!.waiting).toBe(3);
    expect(channel!.items.map((item) => [item.id, item.alsoInStory.map((other) => other.id)])).toEqual([
      [stronger.id, [weaker.id]],
      [alone.id, []],
    ]);
    expect(channel!.items[0]!.storyPublished).toEqual([{ sourceLabel: '@esa', approvedAt: '2026-10-12T09:00:00.000Z' }]);
    expect(channel!.items[1]!.storyPublished).toEqual([]);
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

  it('publishes the post picked from a story’s card, and rejects the rest of the card as already covered', async () => {
    const stack = makeStack();
    vi.stubGlobal('fetch', stack.fetchImpl);
    const picked = await queuedPost();
    const sameStory = await queuedPost({ adminChatId: ADMIN_CHAT, adminMessageId: 78, xAuthorUsername: 'nasa' });
    const decidedElsewhere = await queuedPost({ status: 'rejected', rejectionReason: 'too_minor' });
    const otherStory = await queuedPost();
    await inOneStory(picked.id, sameStory.id, decidedElsewhere.id);
    await inOneStory(otherStory.id);

    const response = await decide({
      action: 'approve',
      postId: picked.id,
      alsoInStory: [sameStory.id, decidedElsewhere.id, otherStory.id],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, alsoRejected: [sameStory.id] });
    expect((await reload(picked.id)).status).toBe('published');
    expect(await reload(sameStory.id)).toMatchObject({ status: 'rejected', rejectionReason: 'already_covered' });
    expect(await reload(decidedElsewhere.id)).toMatchObject({ status: 'rejected', rejectionReason: 'too_minor' });
    expect((await reload(otherStory.id)).status).toBe('awaiting_approval');
    // Its buttons in the chat replaced by the outcome.
    expect(stack.calls.find((call) => call.method === 'editMessageText')?.body).toMatchObject({ message_id: 78 });
  });

  it('turns down a whole story for one reason', async () => {
    vi.stubGlobal('fetch', makeStack().fetchImpl);
    const first = await queuedPost();
    const second = await queuedPost();
    await inOneStory(first.id, second.id);

    const response = await decide({ action: 'reject', postId: second.id, reason: 'other', note: 'Old news', alsoInStory: [first.id] });

    expect(await response.json()).toEqual({ ok: true, alsoRejected: [first.id] });
    for (const id of [first.id, second.id]) {
      expect(await reload(id)).toMatchObject({ status: 'rejected', rejectionReason: 'other', rejectionNote: 'Old news' });
    }
    expect((await decide({ action: 'reject', postId: first.id, reason: 'too_minor', alsoInStory: Array(21).fill(1) })).status).toBe(400);
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
    expect(await hourly.json()).toEqual({
      id: DEFAULT_WORKSPACE_ID,
      reviewDigestMinutes: 180,
      reviewDigestHour: null,
      reviewDigestTimezone: null,
      autoPublish: false,
      queueActive: true,
    });

    const chat = await setInterval({ workspaceId: DEFAULT_WORKSPACE_ID, reviewDigestMinutes: null });
    expect(await chat.json()).toMatchObject({ reviewDigestMinutes: null, queueActive: false });
    expect((await workspaceRow()).reviewDigestMinutes).toBeNull();
  });

  it('sets the hour a daily notification comes at, in the reviewer’s zone, and keeps it when the interval changes', async () => {
    const daily = await setInterval({
      workspaceId: DEFAULT_WORKSPACE_ID,
      reviewDigestMinutes: 1440,
      reviewDigestHour: 20,
      timezone: 'Europe/Kyiv',
    });
    expect(await daily.json()).toMatchObject({ reviewDigestHour: 20, reviewDigestTimezone: 'Europe/Kyiv' });

    await setInterval({ workspaceId: DEFAULT_WORKSPACE_ID, reviewDigestMinutes: 10080 });
    expect(await workspaceRow()).toMatchObject({ reviewDigestMinutes: 10080, reviewDigestHour: 20 });

    await setInterval({ workspaceId: DEFAULT_WORKSPACE_ID, reviewDigestMinutes: 1440, reviewDigestHour: null });
    expect(await workspaceRow()).toMatchObject({ reviewDigestHour: null, reviewDigestTimezone: null });
  });

  it('refuses an hour without its zone, or with a zone that does not exist', async () => {
    const base = { workspaceId: DEFAULT_WORKSPACE_ID, reviewDigestMinutes: 1440, reviewDigestHour: 20 };
    expect((await setInterval(base)).status).toBe(400);
    expect((await setInterval({ ...base, timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await setInterval({ ...base, reviewDigestHour: 24, timezone: 'Europe/Kyiv' })).status).toBe(400);
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

describeIfDb('POST /api/telegram/webapp/channels — publishing without review', () => {
  it('turns it on and off, and the queue with it', async () => {
    const on = await setInterval({ workspaceId: DEFAULT_WORKSPACE_ID, autoPublish: true });
    expect(await on.json()).toEqual({ id: DEFAULT_WORKSPACE_ID, autoPublish: true, queueActive: false });
    expect((await workspaceRow()).autoPublish).toBe(true);

    const off = await setInterval({ workspaceId: DEFAULT_WORKSPACE_ID, autoPublish: false });
    expect(await off.json()).toEqual({ id: DEFAULT_WORKSPACE_ID, autoPublish: false, queueActive: true });
    // The notification interval is left as it was.
    expect((await workspaceRow()).reviewDigestMinutes).toBe(60);
  });

  it('refuses both changes at once, neither, and another reviewer’s channel', async () => {
    await db.insert(workspaces).values({
      id: OTHER_WORKSPACE,
      name: 'second',
      telegramChatId: '-1002000000002',
      telegramAdminChatId: String(OTHER_REVIEWER_ID),
    });

    expect(
      (await setInterval({ workspaceId: DEFAULT_WORKSPACE_ID, autoPublish: true, reviewDigestMinutes: 60 })).status,
    ).toBe(400);
    expect((await setInterval({ workspaceId: DEFAULT_WORKSPACE_ID })).status).toBe(400);
    expect((await setInterval({ workspaceId: OTHER_WORKSPACE, autoPublish: true })).status).toBe(404);
    expect((await workspaceRow(OTHER_WORKSPACE)).autoPublish).toBe(false);
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

describeIfDb('the account API', () => {
  const call = (init?: RequestInit) =>
    withEnv({ ...queueEnv, WEB_APP_URL: 'https://app.example.com' }, () =>
      accountRoute[init ? 'POST' : 'GET'](
        new Request('https://example.vercel.app/api/account', {
          ...init,
          headers: { authorization: auth(), 'content-type': 'application/json' },
        }),
      ),
    );

  it('says where the review buttons go, and changes it', async () => {
    expect(await (await call()).json()).toMatchObject({ reviewLink: 'mini_app', websiteUrl: 'https://app.example.com' });
    expect((await call({ method: 'POST', body: JSON.stringify({ reviewLink: 'website' }) })).status).toBe(200);
    expect(await (await call()).json()).toMatchObject({ reviewLink: 'website' });
    expect((await call({ method: 'POST', body: JSON.stringify({ reviewLink: 'email' }) })).status).toBe(400);
  });
});

describeIfDb('the website editor', () => {
  const rich = (method: 'GET' | 'POST' | 'DELETE', body?: unknown, postId?: number) =>
    withEnv(queueEnv, () =>
      richRoute[method](
        new Request(`https://example.vercel.app/api/telegram/webapp/rich${postId ? `?post=${postId}` : ''}`, {
          method,
          headers: { authorization: auth(), 'content-type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      ),
    );

  const twoPhotos: ApprovalPayload = {
    method: 'sendMediaGroup',
    caption: 'Short caption',
    overflowMessage: 'The whole long text\n\nof the post',
    items: [],
    sourceMedia: [
      { mediaKey: 'a', kind: 'photo', url: 'https://cdn.example/a.jpg', width: 1600, height: 1200 },
      { mediaKey: 'b', kind: 'photo', url: 'https://cdn.example/b.jpg', width: 1600, height: 1200 },
    ],
  };

  const laidOut = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Bears' }] },
      { type: 'postMedia', attrs: { ref: 'm1', caption: 'Second first' } },
      { type: 'paragraph', content: [{ type: 'text', text: 'By the lake.', marks: [{ type: 'bold' }] }] },
    ],
  };

  it('opens a post never edited as its pictures, then its whole text', async () => {
    const post = await queuedPost({
      approvalPayload: twoPhotos,
      reviewMedia: [
        { kind: 'photo', url: 'https://cdn.example/a.jpg' },
        { kind: 'photo', url: 'https://cdn.example/b.jpg' },
      ],
    });

    const body = (await (await rich('GET', undefined, post.id)).json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      isRich: false,
      media: [
        { ref: 'm0', kind: 'photo', previewUrl: 'https://cdn.example/a.jpg' },
        { ref: 'm1', kind: 'photo', previewUrl: 'https://cdn.example/b.jpg' },
      ],
      doc: {
        type: 'doc',
        content: [
          { type: 'postMedia', attrs: { ref: 'm0' } },
          { type: 'postMedia', attrs: { ref: 'm1' } },
          { type: 'paragraph', content: [{ type: 'text', text: 'The whole long text' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'of the post' }] },
        ],
      },
    });
  });

  it('saves a layout, refuses one the channel cannot show, and goes back to the plain post', async () => {
    const post = await queuedPost({ approvalPayload: twoPhotos });

    expect((await rich('POST', { postId: post.id, doc: laidOut })).status).toBe(200);
    expect((await reload(post.id)).richDoc).toEqual(laidOut);

    const bad = { type: 'doc', content: [{ type: 'postMedia', attrs: { ref: 'm7', caption: null } }] };
    expect((await rich('POST', { postId: post.id, doc: bad })).status).toBe(422);
    expect((await reload(post.id)).richDoc).toEqual(laidOut);

    // The Mini App's caption editor would be overwritten by it, so it says where to go.
    const caption = await withEnv(queueEnv, () =>
      captionRoute.GET(new Request(`https://example.vercel.app/api/telegram/webapp/caption?post=${post.id}`, { headers: { authorization: auth() } })),
    );
    expect(caption.status).toBe(409);

    expect((await rich('DELETE', { postId: post.id })).status).toBe(200);
    expect((await reload(post.id)).richDoc).toBeNull();
  });

  it('publishes a laid-out queued post as one rich message, uploading only the pictures it places', async () => {
    const stack = makeStack();
    vi.stubGlobal('fetch', stack.fetchImpl);
    await db.update(workspaces).set({ postFooter: '[Bears](https://t.me/bears)' }).where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
    const post = await queuedPost({ approvalPayload: twoPhotos, richDoc: laidOut as never });

    expect((await decide({ action: 'approve', postId: post.id })).status).toBe(200);

    expect(stack.calls.map((call) => [call.method, call.body.chat_id])).toEqual([['sendRichMessage', CHANNEL_CHAT]]);
    const sent = stack.calls[0]!.body;
    const message = JSON.parse(String(sent.rich_message)) as { html: string; media: { id: string; media: { type: string; media: string } }[] };
    expect(message.html).toBe(
      '<h1>Bears</h1><figure><img src="tg://photo?id=m1"/><figcaption>Second first</figcaption></figure>' +
        '<p><b>By the lake.</b></p><p><a href="https://t.me/bears">Bears</a></p>',
    );
    expect(message.media).toEqual([{ id: 'm1', media: { type: 'photo', media: 'attach://upload_m1' } }]);
    expect(sent.upload_m1).toBeInstanceOf(Blob);

    const row = await reload(post.id);
    expect(row).toMatchObject({ status: 'published', telegramMethod: 'sendRichMessage', mediaCount: 1 });
  });

  it('publishes a laid-out post reviewed in the chat from Telegram’s own copies', async () => {
    const stack = makeStack();
    vi.stubGlobal('fetch', stack.fetchImpl);
    const post = await queuedPost({
      adminChatId: ADMIN_CHAT,
      adminMessageId: 77,
      reviewQueuedAt: null,
      approvalPayload: { method: 'sendPhoto', caption: 'Bear', items: [{ kind: 'photo', fileId: 'FILE_A' }] },
      richDoc: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Above' }] },
          { type: 'postMedia', attrs: { ref: 'm0', caption: null } },
        ],
      } as never,
    });

    expect((await decide({ action: 'approve', postId: post.id })).status).toBe(200);

    expect(stack.calls[0]!.method).toBe('sendRichMessage');
    expect(stack.calls[0]!.body.rich_message).toEqual({
      html: '<p>Above</p><img src="tg://photo?id=m0"/>',
      media: [{ id: 'm0', media: { type: 'photo', media: 'FILE_A' } }],
    });
  });
});
