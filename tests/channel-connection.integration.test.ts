import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import { DEFAULT_WORKSPACE_ID, processedPosts, productEvents, telegramMessages, users, workspaces, type ApprovalPayload } from '@/db/schema';
import { POST as channelsRoute } from '@/app/api/telegram/webapp/channels/route';
import { POST as verifyRoute } from '@/app/api/telegram/webapp/channels/verify/route';
import { POST as eventsRoute } from '@/app/api/telegram/webapp/events/route';
import { POST as previewRoute } from '@/app/api/telegram/webapp/preview/route';
import { GET as queueRoute, POST as decideRoute } from '@/app/api/telegram/webapp/queue/route';
import { POST as scheduleRoute } from '@/app/api/telegram/webapp/schedule/route';
import { GET as sourcesRoute } from '@/app/api/telegram/webapp/sources/route';
import { POST as webhookRoute } from '@/app/api/telegram/webhook/route';
import { buildCallbackData } from '@/lib/sync/approval';
import { publishDueScheduledPosts } from '@/lib/sync/publish-scheduled';
import { ChannelNotConnectedError } from '@/lib/publishing/channel';
import { publishDecidedPost } from '@/lib/sync/publish';
import { TelegramClient } from '@/lib/telegram/client';
import { createLogger } from '@/lib/logger';
import { getEnv } from '@/lib/env';
import { destinationFor, reviewsPosts } from '@/lib/workspace';
import { ensureTestWorkspace, telegramOk, withEnv } from './helpers';

/**
 * A channel onboarded in the bot is reviewed like any other, but nothing is
 * published to it until it is connected: every path to the channel refuses,
 * the queue says so for its popup, and Check — or the bot being made an
 * admin there — connects it, only for someone who can post there themself.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

const BOT_TOKEN = '123456:AAHfakeTokenForTestsOnly';
const BOT_ID = 123456;
const REVIEWER_ID = 555001;
const STRANGER_ID = 777002;
const CHANNEL_CHAT = '-1001000000001';
const SECRET = 'a'.repeat(64);

const env = {
  DATABASE_URL: connectionString,
  DRY_RUN: 'false',
  REQUIRE_APPROVAL: 'true',
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  APP_BASE_URL: 'https://example.vercel.app',
};

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(() => {
  if (!connectionString) return;
  sql = postgres(connectionString, { max: 4, prepare: false });
  db = drizzle(sql, { schema });
});

afterAll(async () => {
  if (sql) await sql.end();
  await (globalThis as { __contentArbitrarySql?: postgres.Sql }).__contentArbitrarySql?.end();
});

let calls: { method: string; body: Record<string, unknown> }[];
/** What getChatMember answers, by user id; missing ids are "not a member" (400). */
let members: Record<number, { status: string; can_post_messages?: boolean }>;

beforeEach(async () => {
  if (!connectionString) return;
  calls = [];
  members = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const method = String(input).split('/').pop()!;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ method, body });
      if (method === 'getMe') return telegramOk({ id: BOT_ID, is_bot: true, username: 'zmistik_test_bot' });
      if (method === 'getChatMember') {
        const member = members[Number(body.user_id)];
        if (!member) {
          return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: member not found' }), { status: 400 });
        }
        return telegramOk(member);
      }
      if (method === 'sendPhoto') {
        return telegramOk({ message_id: 77, chat: { id: Number(body.chat_id) }, photo: [{ file_id: 'ONE', file_size: 1 }] });
      }
      if (method === 'sendMessage') return telegramOk({ message_id: 78, chat: { id: Number(body.chat_id) } });
      return telegramOk(true);
    }),
  );
  await db.delete(productEvents);
  await db.delete(telegramMessages);
  await db.delete(processedPosts);
  await db.delete(users);
  await ensureTestWorkspace(db);
  await db
    .update(workspaces)
    .set({
      name: 'PlayStation UA',
      telegramChatId: CHANNEL_CHAT,
      telegramAdminChatId: String(REVIEWER_ID),
      channelVerifiedAt: null,
      createdVia: 'self_service',
    })
    .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function initDataFor(userId: number): string {
  const fields: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId }) };
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const params = new URLSearchParams(fields);
  params.set('hash', createHmac('sha256', secretKey).update(dataCheckString).digest('hex'));
  return params.toString();
}

const call = (
  route: (request: Request) => Promise<Response>,
  path: string,
  body?: unknown,
  options: { userId?: number; method?: string } = {},
) =>
  withEnv(env, () =>
    route(
      new Request(`https://example.vercel.app${path}`, {
        method: options.method ?? 'POST',
        headers: { authorization: `tma ${initDataFor(options.userId ?? REVIEWER_ID)}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    ),
  );

const webhook = (update: unknown) =>
  withEnv(env, () =>
    webhookRoute(
      new Request('https://example.vercel.app/api/telegram/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
        body: JSON.stringify(update),
      }),
    ),
  );

const PAYLOAD: ApprovalPayload = { method: 'sendPhoto', caption: 'A post', items: [{ kind: 'photo', fileId: 'FILE_A' }] };

async function post(status: 'awaiting_approval' | 'scheduled' = 'awaiting_approval') {
  const [row] = await db
    .insert(processedPosts)
    .values({
      workspaceId: DEFAULT_WORKSPACE_ID,
      externalId: String(1_760_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1e6))),
      xPostUrl: 'https://x.com/someone/status/1',
      xAuthorUsername: 'someone',
      status,
      approvalPayload: PAYLOAD,
      reviewQueuedAt: new Date(),
      caption: 'A post',
      originalCaption: 'A post',
      ...(status === 'scheduled' ? { scheduledFor: new Date(Date.now() - 60_000), scheduledTimezone: 'UTC' } : {}),
    })
    .returning();
  return row!;
}

const reload = async (id: number) => (await db.select().from(processedPosts).where(eq(processedPosts.id, id)))[0]!;
const workspace = async () => (await db.select().from(workspaces).where(eq(workspaces.id, DEFAULT_WORKSPACE_ID)))[0]!;
const eventNames = async () => (await db.select().from(productEvents).orderBy(productEvents.id)).map((row) => row.name);
const sentToChannel = () => calls.filter((entry) => entry.body.chat_id === CHANNEL_CHAT && entry.method.startsWith('send'));

describeIfDb('a channel not connected yet', () => {
  it('is told to the queue page, so Publish and Schedule open the set-up popup', async () => {
    const response = await call(queueRoute, '/api/telegram/webapp/queue', undefined, { method: 'GET' });
    const body = (await response.json()) as { channels: { canPublish: boolean }[] };
    expect(body.channels[0]!.canPublish).toBe(false);

    const settings = (await (await call(sourcesRoute, '/api/telegram/webapp/sources', undefined, { method: 'GET' })).json()) as {
      channels: { channelConnected: boolean }[];
    };
    expect(settings.channels[0]!.channelConnected).toBe(false);
  });

  it('refuses Approve with channel_not_connected, sends nothing and leaves the post waiting', async () => {
    const row = await post();
    const response = await call(decideRoute, '/api/telegram/webapp/queue', { action: 'approve', postId: row.id });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'channel_not_connected' });
    expect(sentToChannel()).toEqual([]);
    expect((await reload(row.id)).status).toBe('awaiting_approval');
  });

  it('refuses Schedule', async () => {
    const row = await post();
    const response = await call(scheduleRoute, '/api/telegram/webapp/schedule', {
      postId: row.id,
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
      timezone: 'UTC',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'channel_not_connected' });
    expect((await reload(row.id)).status).toBe('awaiting_approval');
  });

  it('still sends a preview, to the reviewer’s own chat', async () => {
    const row = await post();
    const response = await call(previewRoute, '/api/telegram/webapp/preview', { postId: row.id });
    expect(response.status).toBe(200);
    expect(calls.filter((entry) => entry.method === 'sendPhoto').map((entry) => entry.body.chat_id)).toEqual([String(REVIEWER_ID)]);
    expect(sentToChannel()).toEqual([]);
  });

  it('refuses turning on publishing without review, but lets it be turned off', async () => {
    const on = await call(channelsRoute, '/api/telegram/webapp/channels', { workspaceId: DEFAULT_WORKSPACE_ID, autoPublish: true });
    expect(on.status).toBe(409);
    expect((await workspace()).autoPublish).toBe(false);
    const off = await call(channelsRoute, '/api/telegram/webapp/channels', { workspaceId: DEFAULT_WORKSPACE_ID, autoPublish: false });
    expect(off.status).toBe(200);
  });

  it('answers the chat’s Approve with an alert, and publishes nothing', async () => {
    const row = await post();
    const response = await webhook({
      update_id: 1,
      callback_query: {
        id: 'cb1',
        from: { id: REVIEWER_ID },
        data: buildCallbackData('approve', row.id),
        message: { message_id: 5, chat: { id: REVIEWER_ID } },
      },
    });
    expect(response.status).toBe(200);
    const answer = calls.find((entry) => entry.method === 'answerCallbackQuery');
    expect(answer?.body).toMatchObject({ show_alert: true });
    expect(String(answer?.body.text)).toMatch(/Publishing channel/);
    expect(sentToChannel()).toEqual([]);
    expect((await reload(row.id)).status).toBe('awaiting_approval');
  });

  it('does not let the scheduler publish a post scheduled before, nor publishDecidedPost at all', async () => {
    const row = await post('scheduled');
    const summary = await withEnv(env, () =>
      publishDueScheduledPosts({ db, env: getEnv(), client: new TelegramClient(), logger: createLogger({ app: 'test' }), sleep: async () => {} }),
    );
    expect(summary.published).toBe(0);
    expect(sentToChannel()).toEqual([]);

    const ws = await workspace();
    const destination = await withEnv(env, () => destinationFor(ws, getEnv()));
    expect(destination.ok).toBe(true);
    expect(destination.ok && destination.destination.channelConnected).toBe(false);
    await expect(
      withEnv(env, () =>
        publishDecidedPost({
          db,
          env: getEnv(),
          client: new TelegramClient(),
          row,
          payload: PAYLOAD,
          destination: (destination as { ok: true; destination: never }).destination,
        }),
      ),
    ).rejects.toBeInstanceOf(ChannelNotConnectedError);
  });

  it('always reviews its posts, even set to publish without review or with approval off', async () => {
    const ws = { ...(await workspace()), autoPublish: true };
    expect(reviewsPosts(ws, { REQUIRE_APPROVAL: false })).toBe(true);
    const destination = await withEnv({ ...env, REQUIRE_APPROVAL: 'false' }, () => destinationFor(ws, getEnv()));
    expect(destination.ok).toBe(true);
    expect(destination.ok && destination.destination.autoPublish).toBeFalsy();
    expect(reviewsPosts({ ...ws, channelVerifiedAt: new Date() }, { REQUIRE_APPROVAL: true })).toBe(false);
  });
});

describeIfDb('connecting the channel with Check', () => {
  it('connects when the bot can post there and so can the person pressing it; then Approve publishes', async () => {
    members[BOT_ID] = { status: 'administrator', can_post_messages: true };
    members[REVIEWER_ID] = { status: 'creator' };

    const response = await call(verifyRoute, '/api/telegram/webapp/channels/verify', { workspaceId: DEFAULT_WORKSPACE_ID });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connected: true });
    expect((await workspace()).channelVerifiedAt).not.toBeNull();

    const row = await post();
    const approved = await call(decideRoute, '/api/telegram/webapp/queue', { action: 'approve', postId: row.id });
    expect(approved.status).toBe(200);
    expect(sentToChannel().map((entry) => entry.method)).toEqual(['sendPhoto']);
    expect((await reload(row.id)).status).toBe('published');

    expect(await eventNames()).toEqual(['channel.check', 'channel.connected', 'post.approved']);
    const [check, connected, approval] = await db.select().from(productEvents).orderBy(productEvents.id);
    expect(check).toMatchObject({ workspaceId: DEFAULT_WORKSPACE_ID, props: { result: 'connected' } });
    expect(connected?.props).toEqual({ via: 'check' });
    expect(approval?.props).toMatchObject({ action: 'publish', via: 'queue' });
  });

  it.each([
    ['channel_unreachable', {}, { status: 'creator' }],
    ['bot_not_admin', { status: 'member' }, { status: 'creator' }],
    ['bot_cannot_post', { status: 'administrator', can_post_messages: false }, { status: 'creator' }],
    ['user_not_admin', { status: 'administrator', can_post_messages: true }, { status: 'member' }],
    ['user_not_admin', { status: 'administrator', can_post_messages: true }, { status: 'administrator', can_post_messages: false }],
    ['user_not_admin', { status: 'administrator', can_post_messages: true }, null],
  ] as const)('refuses with %s, and changes nothing', async (reason, bot, user) => {
    if ('status' in bot) members[BOT_ID] = bot;
    if (user) members[REVIEWER_ID] = user;
    const response = await call(verifyRoute, '/api/telegram/webapp/channels/verify', { workspaceId: DEFAULT_WORKSPACE_ID });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { reason: string; error: string };
    expect(body.reason).toBe(reason);
    expect(body.error.length).toBeGreaterThan(0);
    expect((await workspace()).channelVerifiedAt).toBeNull();
    expect((await db.select().from(productEvents))[0]?.props).toEqual({ result: reason });
  });

  it('refuses a channel that is not the reviewer’s', async () => {
    const response = await call(verifyRoute, '/api/telegram/webapp/channels/verify', { workspaceId: DEFAULT_WORKSPACE_ID }, { userId: STRANGER_ID });
    expect(response.status).toBe(401);
    expect((await workspace()).channelVerifiedAt).toBeNull();
  });
});

describeIfDb('connecting the channel by making the bot an admin', () => {
  const promotion = (fromId: number, canPost = true) => ({
    update_id: 2,
    my_chat_member: {
      chat: { id: Number(CHANNEL_CHAT), type: 'channel', title: 'PlayStation UA' },
      from: { id: fromId },
      date: 1,
      old_chat_member: { status: 'left', user: { id: BOT_ID } },
      new_chat_member: { status: 'administrator', can_post_messages: canPost, user: { id: BOT_ID } },
    },
  });

  it('connects when its reviewer did it, and tells them', async () => {
    members[BOT_ID] = { status: 'administrator', can_post_messages: true };
    members[REVIEWER_ID] = { status: 'administrator', can_post_messages: true };
    expect((await webhook(promotion(REVIEWER_ID))).status).toBe(200);
    expect((await workspace()).channelVerifiedAt).not.toBeNull();
    const notice = calls.find((entry) => entry.method === 'sendMessage');
    expect(notice?.body.chat_id).toBe(String(REVIEWER_ID));
    expect(String(notice?.body.text)).toMatch(/connected/);
  });

  it('does not connect it for someone who does not review it', async () => {
    members[BOT_ID] = { status: 'administrator', can_post_messages: true };
    members[STRANGER_ID] = { status: 'creator' };
    await webhook(promotion(STRANGER_ID));
    expect((await workspace()).channelVerifiedAt).toBeNull();
    expect(calls.some((entry) => entry.method === 'sendMessage')).toBe(false);
  });

  it('does nothing when the bot was made an admin that cannot post', async () => {
    await webhook(promotion(REVIEWER_ID, false));
    expect((await workspace()).channelVerifiedAt).toBeNull();
    expect(calls.some((entry) => entry.method === 'getChatMember')).toBe(false);
  });
});

describeIfDb('events a page reports', () => {
  it('records the popup, Open Settings and the queue opened from a digest, for the reviewer’s channel', async () => {
    for (const body of [
      { name: 'publish.blocked', workspaceId: DEFAULT_WORKSPACE_ID, props: { action: 'schedule' } },
      { name: 'publish.popup_settings', workspaceId: DEFAULT_WORKSPACE_ID },
      { name: 'queue.opened', workspaceId: DEFAULT_WORKSPACE_ID, props: { from: 'digest' } },
    ]) {
      expect((await call(eventsRoute, '/api/telegram/webapp/events', body)).status).toBe(204);
    }
    const rows = await db.select().from(productEvents).orderBy(productEvents.id);
    expect(rows.map((row) => [row.name, row.workspaceId, row.props])).toEqual([
      ['publish.blocked', DEFAULT_WORKSPACE_ID, { action: 'schedule' }],
      ['publish.popup_settings', DEFAULT_WORKSPACE_ID, {}],
      ['queue.opened', DEFAULT_WORKSPACE_ID, { from: 'digest' }],
    ]);
    expect(rows[0]?.userId).not.toBeNull();
  });

  it('refuses any other event or prop, and records another channel as none', async () => {
    expect((await call(eventsRoute, '/api/telegram/webapp/events', { name: 'post.approved', props: {} })).status).toBe(400);
    expect((await call(eventsRoute, '/api/telegram/webapp/events', { name: 'queue.opened', props: { from: 'elsewhere' } })).status).toBe(400);
    expect(
      (await call(eventsRoute, '/api/telegram/webapp/events', { name: 'queue.opened', props: { from: 'digest', note: 'x' } })).status,
    ).toBe(400);
    await call(eventsRoute, '/api/telegram/webapp/events', { name: 'queue.opened', workspaceId: 999_999, props: { from: 'command' } });
    expect(await db.select().from(productEvents)).toMatchObject([{ name: 'queue.opened', workspaceId: null }]);
  });

  it('is refused to someone who reviews nothing', async () => {
    const response = await call(eventsRoute, '/api/telegram/webapp/events', { name: 'publish.popup_settings' }, { userId: STRANGER_ID });
    expect(response.status).toBe(401);
    expect(await db.select().from(productEvents)).toEqual([]);
  });
});
