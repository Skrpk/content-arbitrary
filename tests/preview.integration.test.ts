import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import { DEFAULT_WORKSPACE_ID, processedPosts, telegramMessages, workspaces, type ApprovalPayload } from '@/db/schema';
import { POST as previewRoute } from '@/app/api/telegram/webapp/preview/route';
import { POST as channelsRoute } from '@/app/api/telegram/webapp/channels/route';
import { GET as queueRoute, POST as decideRoute } from '@/app/api/telegram/webapp/queue/route';
import { previewChannelRef } from '@/lib/review/preview-channel';
import { ensureTestWorkspace, telegramOk, withEnv } from './helpers';

/**
 * Send to preview, from the Approve dialog: the post goes to the channel's
 * preview channel as it would go out, and nothing is decided. And the preview
 * channel itself, set in Settings once Telegram confirms the bot can post there.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

const BOT_TOKEN = '123456:AAHfakeTokenForTestsOnly';
const BOT_ID = 123456;
const REVIEWER_ID = 555001;
const STRANGER_ID = 777002;
const CHANNEL_CHAT = '-1001000000001';
const PREVIEW_CHAT = '-1003000000003';
const PREVIEW_MESSAGE_ID = 77;

const env = {
  DATABASE_URL: connectionString,
  DRY_RUN: 'false',
  REQUIRE_APPROVAL: 'true',
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(64),
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
/** What Telegram says of a chat and of the bot in it, by the reference asked for. */
let chats: Record<string, { id: number; type: string; title: string }>;
let member: { status: string; can_post_messages?: boolean };

beforeEach(async () => {
  if (!connectionString) return;
  calls = [];
  chats = { '@vector_previews': { id: Number(PREVIEW_CHAT), type: 'channel', title: 'Vector previews' } };
  chats[PREVIEW_CHAT] = chats['@vector_previews']!;
  chats['@vector'] = { id: Number(CHANNEL_CHAT), type: 'channel', title: 'Vector' };
  member = { status: 'administrator', can_post_messages: true };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const method = String(input).split('/').pop()!;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ method, body });
      if (method === 'getMe') return telegramOk({ id: BOT_ID, is_bot: true, first_name: 'Zmistik', username: 'zmistik_bot' });
      if (method === 'getChat') {
        const chat = chats[String(body.chat_id)];
        return chat
          ? telegramOk(chat)
          : new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }), { status: 400 });
      }
      if (method === 'getChatMember') return telegramOk({ ...member, user: { id: BOT_ID } });
      if (method === 'sendPhoto') {
        return telegramOk({ message_id: PREVIEW_MESSAGE_ID, chat: { id: Number(body.chat_id) }, photo: [{ file_id: 'ONE', file_size: 1 }] });
      }
      return telegramOk(true);
    }),
  );
  await db.delete(telegramMessages);
  await db.delete(processedPosts);
  await ensureTestWorkspace(db);
  await db
    .update(workspaces)
    .set({ name: 'Vector', telegramChatId: CHANNEL_CHAT, telegramAdminChatId: String(REVIEWER_ID), previewChatId: PREVIEW_CHAT, postFooter: null })
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

const call = (route: (request: Request) => Promise<Response>, path: string, body?: unknown, options: { userId?: number; method?: string } = {}) =>
  withEnv(env, () =>
    route(
      new Request(`https://example.vercel.app${path}`, {
        method: options.method ?? 'POST',
        headers: { authorization: `tma ${initDataFor(options.userId ?? REVIEWER_ID)}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    ),
  );

const PAYLOAD: ApprovalPayload = { method: 'sendPhoto', caption: 'A post', items: [{ kind: 'photo', fileId: 'FILE_A' }] };

async function queuedPost() {
  const [row] = await db
    .insert(processedPosts)
    .values({
      workspaceId: DEFAULT_WORKSPACE_ID,
      externalId: String(1_760_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1e6))),
      xPostUrl: 'https://x.com/someone/status/1',
      xAuthorUsername: 'someone',
      status: 'awaiting_approval',
      approvalPayload: PAYLOAD,
      reviewQueuedAt: new Date(),
      caption: 'A post',
      originalCaption: 'A post',
    })
    .returning();
  return row!;
}

const reload = async (id: number) => (await db.select().from(processedPosts).where(eq(processedPosts.id, id)))[0]!;

describeIfDb('Send to preview', () => {
  it('sends the post to the preview channel as it would go out, and decides nothing, as often as asked', async () => {
    const post = await queuedPost();

    const response = await call(previewRoute, '/api/telegram/webapp/preview', { postId: post.id });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, link: `https://t.me/c/3000000003/${PREVIEW_MESSAGE_ID}` });

    const sent = calls.filter((entry) => entry.method === 'sendPhoto');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ chat_id: PREVIEW_CHAT, photo: 'FILE_A', caption: 'A post', disable_notification: true });
    expect(calls.some((entry) => entry.body.chat_id === CHANNEL_CHAT)).toBe(false);

    const after = await reload(post.id);
    expect(after.status).toBe('awaiting_approval');
    expect(after.approvalPayload).toEqual(PAYLOAD);
    expect(await db.select().from(telegramMessages)).toHaveLength(0);

    // Again after an edit: a new copy, the post still waiting.
    await db.update(processedPosts).set({ caption: 'A better post' }).where(eq(processedPosts.id, post.id));
    expect((await call(previewRoute, '/api/telegram/webapp/preview', { postId: post.id })).status).toBe(200);
    expect(calls.filter((entry) => entry.method === 'sendPhoto').at(-1)!.body.caption).toBe('A better post');
    expect((await reload(post.id)).status).toBe('awaiting_approval');

    // Then approved, it goes to the channel itself.
    expect((await call(decideRoute, '/api/telegram/webapp/queue', { action: 'approve', postId: post.id })).status).toBe(200);
    expect(calls.filter((entry) => entry.method === 'sendPhoto').at(-1)!.body.chat_id).toBe(CHANNEL_CHAT);
  });

  it('is off without a preview channel, and only for the post’s own reviewer while it waits', async () => {
    const post = await queuedPost();
    expect((await call(previewRoute, '/api/telegram/webapp/preview', { postId: post.id }, { userId: STRANGER_ID })).status).toBe(401);

    await db.update(workspaces).set({ previewChatId: null }).where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
    const none = await call(previewRoute, '/api/telegram/webapp/preview', { postId: post.id });
    expect(none.status).toBe(422);
    expect(((await none.json()) as { error: string }).error).toContain('Settings');

    await db.update(processedPosts).set({ status: 'published' }).where(eq(processedPosts.id, post.id));
    expect((await call(previewRoute, '/api/telegram/webapp/preview', { postId: post.id })).status).toBe(409);
    expect(calls.some((entry) => entry.method === 'sendPhoto')).toBe(false);
  });

  it('tells the queue page which channels have one', async () => {
    const queue = (await (await call(queueRoute, '/api/telegram/webapp/queue', undefined, { method: 'GET' })).json()) as {
      channels: { id: number; preview: boolean }[];
    };
    expect(queue.channels.find((channel) => channel.id === DEFAULT_WORKSPACE_ID)?.preview).toBe(true);
  });
});

describeIfDb('the preview channel in Settings', () => {
  const set = (previewChannel: string | null) =>
    call(channelsRoute, '/api/telegram/webapp/channels', { workspaceId: DEFAULT_WORKSPACE_ID, previewChannel });
  const stored = async () => (await db.select().from(workspaces).where(eq(workspaces.id, DEFAULT_WORKSPACE_ID)))[0]!.previewChatId;

  it('is kept by its id once the bot is found able to post there, and cleared again', async () => {
    await db.update(workspaces).set({ previewChatId: null }).where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
    const response = await set('https://t.me/vector_previews');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: DEFAULT_WORKSPACE_ID, previewChannel: { chatId: PREVIEW_CHAT, title: 'Vector previews' } });
    expect(await stored()).toBe(PREVIEW_CHAT);

    expect((await set(null)).status).toBe(200);
    expect(await stored()).toBeNull();
  });

  it('is refused where the bot may not post, for the channel itself, and for a chat Telegram does not show', async () => {
    member = { status: 'administrator', can_post_messages: false };
    expect((await set('@vector_previews')).status).toBe(422);
    member = { status: 'left' };
    expect((await set('@vector_previews')).status).toBe(422);

    member = { status: 'administrator', can_post_messages: true };
    const itself = await set('@vector');
    expect(itself.status).toBe(422);
    expect(((await itself.json()) as { error: string }).error).toContain('the channel itself');

    expect((await set('@nowhere_at_all')).status).toBe(422);
    expect((await set('not a channel!')).status).toBe(422);
    expect(await stored()).toBe(PREVIEW_CHAT);
  });
});

describe('what may be typed for a preview channel', () => {
  it('is an @username, a t.me link, or an id', () => {
    expect(previewChannelRef('@my_previews')).toBe('@my_previews');
    expect(previewChannelRef('my_previews')).toBe('@my_previews');
    expect(previewChannelRef('https://t.me/my_previews')).toBe('@my_previews');
    expect(previewChannelRef('-1001234567890')).toBe('-1001234567890');
    expect(previewChannelRef('t.me/+inviteHash')).toBeNull();
    expect(previewChannelRef('hello world')).toBeNull();
  });
});
