import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import { channelDrafts, DEFAULT_WORKSPACE_ID, processedPosts, telegramMessages, workspaces } from '@/db/schema';
import { POST } from '@/app/api/telegram/webhook/route';
import * as scheduledRoute from '@/app/api/telegram/webapp/scheduled/route';
import { openDraft, publishDueDrafts } from '@/lib/drafts/drafts';
import { markPublished } from '@/lib/sync/repository';
import { TelegramClient } from '@/lib/telegram/client';
import { ensureTestWorkspace, silentLogger, telegramError, telegramOk, withEnv } from './helpers';

/**
 * The draft channel end to end: Approve puts a post in the draft channel with
 * its control message under it, and the buttons and replies there send it on —
 * through the webhook route itself, against a real database, with only the
 * Bot API stubbed out.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

const SECRET = 'b'.repeat(64);
const REVIEWER_ID = 555001;
const STRANGER_ID = 424242;
const CHANNEL_CHAT = '-1001000000001';
const DRAFT_CHAT = '-1003000000003';
const REVIEW_CONTROL_ID = 12;
const DRAFT_POST_ID = 900;
const DRAFT_CONTROL_ID = 901;
const COPY_ID = 5000;

const routeEnv = {
  DATABASE_URL: connectionString,
  TELEGRAM_CHAT_ID: CHANNEL_CHAT,
  TELEGRAM_ADMIN_CHAT_ID: String(REVIEWER_ID),
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  REQUIRE_APPROVAL: 'true',
  APP_BASE_URL: 'https://example.vercel.app',
};

let calls: { method: string; body: Record<string, unknown> }[];
let failMethod: string | null;

function stubTelegram() {
  calls = [];
  failMethod = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const method = String(input).split('/').pop()!;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ method, body });
      if (failMethod === method) return telegramError(400, 'Bad Request: something went wrong');
      if (method === 'sendPhoto') {
        return telegramOk({ message_id: DRAFT_POST_ID, chat: { id: Number(body.chat_id) }, photo: [{ file_id: 'ONE', file_size: 1 }] });
      }
      if (method === 'sendMessage') return telegramOk({ message_id: DRAFT_CONTROL_ID, chat: { id: Number(body.chat_id) } });
      if (method === 'copyMessages') return telegramOk((body.message_ids as number[]).map((_, index) => ({ message_id: COPY_ID + index })));
      return telegramOk(true);
    }),
  );
}

const callsTo = (method: string) => calls.filter((call) => call.method === method);
const buttonData = (call: { body: Record<string, unknown> } | undefined) =>
  ((call?.body.reply_markup as { inline_keyboard: { callback_data?: string; url?: string }[][] } | undefined)?.inline_keyboard ?? [])
    .flat()
    .map((button) => button.callback_data ?? button.url);

function update(body: Record<string, unknown>) {
  return withEnv(routeEnv, () =>
    POST(
      new Request('https://example.vercel.app/api/telegram/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
        body: JSON.stringify({ update_id: 1, ...body }),
      }),
    ),
  );
}

const press = (data: string, options: { fromId?: number; chatId?: string; messageId?: number } = {}) =>
  update({
    callback_query: {
      id: 'cb-1',
      from: { id: options.fromId ?? REVIEWER_ID },
      data,
      message: { message_id: options.messageId ?? DRAFT_CONTROL_ID, chat: { id: Number(options.chatId ?? DRAFT_CHAT) } },
    },
  });

const reply = (text: string, options: { chatId?: string; to?: number } = {}) =>
  update({
    channel_post: {
      message_id: 950,
      chat: { id: Number(options.chatId ?? DRAFT_CHAT) },
      text,
      reply_to_message: { message_id: options.to ?? DRAFT_CONTROL_ID },
    },
  });

async function queuePost() {
  const [row] = await db
    .insert(processedPosts)
    .values({
      workspaceId: DEFAULT_WORKSPACE_ID,
      externalId: String(1_750_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1e6))),
      xPostUrl: 'https://x.com/someone/status/1750000000000000001',
      xAuthorUsername: 'someone',
      status: 'awaiting_approval',
      adminChatId: String(REVIEWER_ID),
      adminMessageId: REVIEW_CONTROL_ID,
      approvalPayload: { method: 'sendPhoto', caption: 'A post', items: [{ kind: 'photo', fileId: 'FILE_A' }] },
      originalCaption: 'A post',
      caption: 'A post',
    })
    .returning();
  return row!;
}

/**
 * A post approved into the draft channel before approving stopped going
 * there, and its draft: published to the draft channel, with its control
 * message under it — as the old Approve left it.
 */
async function approveIntoDraft() {
  const post = await queuePost();
  await markPublished(db as never, {
    id: post.id,
    telegramChatId: DRAFT_CHAT,
    primaryMessageId: DRAFT_POST_ID,
    telegramMethod: 'sendPhoto',
    mediaCount: 1,
    messages: [{ messageId: DRAFT_POST_ID, mediaIndex: 0, kind: 'photo' }],
    reviewedAt: new Date(),
  });
  const draft = await openDraft(
    { db: db as never, client: new TelegramClient({ token: '123456:AAHfakeTokenForTestsOnly', baseUrl: 'https://api.telegram.org', sleep: async () => {} }), logger: silentLogger },
    { postId: post.id, workspaceId: DEFAULT_WORKSPACE_ID, draftChatId: DRAFT_CHAT, messageIds: [DRAFT_POST_ID] },
  );
  calls.length = 0;
  return { post, draft: (await reloadDraft(draft.id))! };
}

const reloadDraft = async (id: number) => (await db.select().from(channelDrafts).where(eq(channelDrafts.id, id)))[0]!;
const reloadPost = async (id: number) => (await db.select().from(processedPosts).where(eq(processedPosts.id, id)))[0]!;

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
  stubTelegram();
  await db.delete(telegramMessages);
  await db.delete(processedPosts);
  await ensureTestWorkspace(db);
  await db
    .update(workspaces)
    .set({
      name: 'Vector',
      telegramChatId: CHANNEL_CHAT,
      telegramAdminChatId: String(REVIEWER_ID),
      reviewDigestTimezone: 'Europe/Prague',
    })
    .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describeIfDb('Approve, now that drafts are no longer opened', () => {
  it('publishes straight to the channel, and opens no draft', async () => {
    const post = await queuePost();

    await press(`ap:${post.id}`, { chatId: String(REVIEWER_ID), messageId: REVIEW_CONTROL_ID });

    expect(callsTo('sendPhoto')[0]?.body.chat_id).toBe(CHANNEL_CHAT);
    expect(calls.some((call) => call.body.chat_id === DRAFT_CHAT)).toBe(false);
    expect(await db.select().from(channelDrafts)).toHaveLength(0);
    const settled = callsTo('editMessageText').find((call) => call.body.chat_id === String(REVIEWER_ID));
    expect(settled?.body.text).toContain('✅ Published');
  });

  it('left a draft opened before with its control message under the post', async () => {
    const { draft } = await approveIntoDraft();
    expect(draft).toMatchObject({ status: 'waiting', draftChatId: DRAFT_CHAT, messageIds: [DRAFT_POST_ID], controlMessageId: DRAFT_CONTROL_ID, scheduledTimezone: 'Europe/Prague' });
  });
});

describeIfDb('Publish now', () => {
  it('copies the post from the draft channel to the channel and says so under it', async () => {
    const { post, draft } = await approveIntoDraft();

    await press(`dn:${draft.id}`);

    const [copy] = callsTo('copyMessages');
    expect(copy?.body).toMatchObject({ chat_id: CHANNEL_CHAT, from_chat_id: DRAFT_CHAT, message_ids: [DRAFT_POST_ID] });
    const after = await reloadDraft(draft.id);
    expect(after).toMatchObject({ status: 'published', publishedChatId: CHANNEL_CHAT, publishedMessageIds: [COPY_ID] });

    // The post's record points at the channel's copy now.
    const row = await reloadPost(post.id);
    expect(row.telegramChatId).toBe(CHANNEL_CHAT);
    expect(row.telegramMessageId).toBe(COPY_ID);
    const messages = await db
      .select()
      .from(telegramMessages)
      .where(and(eq(telegramMessages.processedPostId, post.id), eq(telegramMessages.telegramChatId, CHANNEL_CHAT)));
    expect(messages.map((message) => message.telegramMessageId)).toEqual([COPY_ID]);

    const control = callsTo('editMessageText').at(-1);
    expect(control?.body.message_id).toBe(DRAFT_CONTROL_ID);
    expect(control?.body.text).toContain('✅ Published to <b>Vector</b>');
    expect(buttonData(control)).toEqual([`https://t.me/c/1000000001/${COPY_ID}`]);
    expect(callsTo('answerCallbackQuery').at(-1)?.body.text).toBe('Published to the channel.');
  });

  it('sends it once, however often it is pressed', async () => {
    const { draft } = await approveIntoDraft();

    await press(`dn:${draft.id}`);
    await press(`dn:${draft.id}`);

    expect(callsTo('copyMessages')).toHaveLength(1);
    expect(callsTo('answerCallbackQuery').at(-1)?.body.text).toBe('Already published.');
  });

  it('puts it back with the error on its control message when the copy fails', async () => {
    const { draft } = await approveIntoDraft();
    failMethod = 'copyMessages';

    await press(`dn:${draft.id}`);

    const after = await reloadDraft(draft.id);
    expect(after.status).toBe('waiting');
    expect(after.error).toContain('Publishing failed');
    expect(callsTo('editMessageText').at(-1)?.body.text).toContain('⚠️ Publishing failed');
    expect(callsTo('answerCallbackQuery').at(-1)?.body.text).toBe('Publishing failed — try again.');
  });

  it('lets nobody but the channel’s reviewer press it', async () => {
    const { draft } = await approveIntoDraft();

    await press(`dn:${draft.id}`, { fromId: STRANGER_ID });

    expect(callsTo('copyMessages')).toHaveLength(0);
    expect((await reloadDraft(draft.id)).status).toBe('waiting');
  });
});

describeIfDb('A time in reply', () => {
  it('schedules the draft, in the reviewer’s zone, and removes the reply', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-18T13:00:00.000Z'), toFake: ['Date'] });
    const { draft } = await approveIntoDraft();

    await reply('завтра 9:00');

    const after = await reloadDraft(draft.id);
    expect(after.status).toBe('scheduled');
    expect(after.scheduledFor?.toISOString()).toBe('2026-11-19T08:00:00.000Z');
    expect(callsTo('deleteMessage')[0]?.body).toMatchObject({ chat_id: DRAFT_CHAT, message_id: 950 });
    const control = callsTo('editMessageText').at(-1);
    expect(control?.body.text).toContain('🕒 Scheduled for Thu 19 Nov, 09:00');
    expect(buttonData(control)).toEqual([`dn:${draft.id}`, `du:${draft.id}`, `dr:${draft.id}`]);
  });

  it('says why when it is not a time, and schedules nothing', async () => {
    const { draft } = await approveIntoDraft();

    await reply('коли буде час');

    const after = await reloadDraft(draft.id);
    expect(after.status).toBe('waiting');
    expect(after.error).toContain('is not a time I can read');
    expect(callsTo('editMessageText').at(-1)?.body.text).toContain('⚠️');
    expect(callsTo('deleteMessage')).toHaveLength(1);
  });

  it('ignores replies to anything but a control message, and other channels’ posts', async () => {
    const { draft } = await approveIntoDraft();

    await reply('18:30', { to: DRAFT_POST_ID });
    await reply('18:30', { chatId: CHANNEL_CHAT });
    await update({ channel_post: { message_id: 951, chat: { id: Number(DRAFT_CHAT) }, text: '18:30' } });

    expect((await reloadDraft(draft.id)).status).toBe('waiting');
    expect(calls).toHaveLength(0);
  });

  it('goes out when its time comes, and is unscheduled with its button', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-18T13:00:00.000Z'), toFake: ['Date'] });
    const { draft } = await approveIntoDraft();
    await reply('18:30');
    await press(`du:${draft.id}`);
    expect((await reloadDraft(draft.id)).status).toBe('waiting');

    await reply('18:30');
    const client = new TelegramClient({ token: 'test-token', baseUrl: 'https://api.telegram.org', attempts: 1 });
    const env = { TELEGRAM_DISABLE_NOTIFICATION: false, MAX_RETRY_ATTEMPTS: 3 };

    const early = await publishDueDrafts({ db, client, env, logger: silentLogger, now: new Date('2026-11-18T17:00:00.000Z') });
    expect(early.due).toBe(0);
    const due = await publishDueDrafts({ db, client, env, logger: silentLogger, now: new Date('2026-11-18T17:31:00.000Z') });
    expect(due).toMatchObject({ due: 1, published: 1 });
    expect(callsTo('copyMessages')).toHaveLength(1);
    expect((await reloadDraft(draft.id)).status).toBe('published');
  });

  it('is tried again next minute when it fails, and handed back after too many tries', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-18T13:00:00.000Z'), toFake: ['Date'] });
    const { draft } = await approveIntoDraft();
    await reply('18:30');
    failMethod = 'copyMessages';
    const client = new TelegramClient({ token: 'test-token', baseUrl: 'https://api.telegram.org', attempts: 1 });
    const env = { TELEGRAM_DISABLE_NOTIFICATION: false, MAX_RETRY_ATTEMPTS: 2 };
    const now = new Date('2026-11-18T17:31:00.000Z');

    await publishDueDrafts({ db, client, env, logger: silentLogger, now });
    expect(await reloadDraft(draft.id)).toMatchObject({ status: 'scheduled', attempts: 1 });

    await publishDueDrafts({ db, client, env, logger: silentLogger, now });
    const after = await reloadDraft(draft.id);
    expect(after).toMatchObject({ status: 'waiting', scheduledFor: null });
    expect(after.error).toContain('Publishing failed 2 times');
  });
});

describeIfDb('Edits and rejection', () => {
  it('notes an edit to the post on its control message, once', async () => {
    const { draft } = await approveIntoDraft();
    const edit = () => update({ edited_channel_post: { message_id: DRAFT_POST_ID, chat: { id: Number(DRAFT_CHAT) }, text: 'Better' } });

    await edit();
    await edit();

    expect((await reloadDraft(draft.id)).editedAt).toBeInstanceOf(Date);
    const refreshes = callsTo('editMessageText');
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]?.body.text).toContain('✏️ Edited here');
  });

  it('records a rejection on the post, and takes it back on Restore', async () => {
    const { post, draft } = await approveIntoDraft();

    await press(`dr:${draft.id}`);
    expect((await reloadDraft(draft.id)).status).toBe('rejected');
    expect(await reloadPost(post.id)).toMatchObject({ status: 'rejected', rejectionReason: 'other' });
    expect(buttonData(callsTo('editMessageText').at(-1))).toEqual([`dx:${draft.id}`]);

    // Rejected: Publish now does nothing.
    await press(`dn:${draft.id}`);
    expect(callsTo('copyMessages')).toHaveLength(0);

    await press(`dx:${draft.id}`);
    expect((await reloadDraft(draft.id)).status).toBe('waiting');
    expect(await reloadPost(post.id)).toMatchObject({ status: 'published', rejectionReason: null });
  });

  it('explains how to schedule on the Schedule button', async () => {
    const { draft } = await approveIntoDraft();

    await press(`dt:${draft.id}`);

    const [answer] = callsTo('answerCallbackQuery');
    expect(answer?.body.show_alert).toBe(true);
    expect(answer?.body.text).toContain('Reply to this message');
  });
});

describeIfDb('the Scheduled page', () => {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
  const auth = (userId = REVIEWER_ID) => {
    const fields: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId }) };
    const check = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const params = new URLSearchParams(fields);
    params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
    return `tma ${params.toString()}`;
  };
  const list = async () => {
    const response = await withEnv(routeEnv, () =>
      scheduledRoute.GET(new Request('https://example.vercel.app/api/telegram/webapp/scheduled', { headers: { authorization: auth() } })),
    );
    const body = (await response.json()) as { channels: { id: number; items: { id: number; draft?: { id: number; link: string | null }; scheduledFor: string }[] }[] };
    return body.channels.find((channel) => channel.id === DEFAULT_WORKSPACE_ID)!.items;
  };
  const act = (body: unknown, userId = REVIEWER_ID) =>
    withEnv(routeEnv, () =>
      scheduledRoute.POST(
        new Request('https://example.vercel.app/api/telegram/webapp/scheduled', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: auth(userId) },
          body: JSON.stringify(body),
        }),
      ),
    );

  it('lists a post scheduled from the draft channel, with a link to it there', async () => {
    const { post, draft } = await approveIntoDraft();
    expect(await list()).toEqual([]);

    await reply('завтра 9:00');

    const [item] = await list();
    expect(item).toMatchObject({ id: post.id, draft: { id: draft.id, link: `https://t.me/c/3000000003/${DRAFT_POST_ID}` } });
  });

  it('counts a post scheduled from the draft channel for the header', async () => {
    const count = async () => {
      const response = await withEnv(routeEnv, () =>
        scheduledRoute.GET(
          new Request('https://example.vercel.app/api/telegram/webapp/scheduled?count=1', { headers: { authorization: auth() } }),
        ),
      );
      return ((await response.json()) as { count: number }).count;
    };
    await approveIntoDraft();
    expect(await count()).toBe(0);

    await reply('завтра 9:00');

    expect(await count()).toBe(1);
  });

  it('moves its time, and its control message says so', async () => {
    const { draft } = await approveIntoDraft();
    await reply('завтра 9:00');
    calls.length = 0;
    const at = new Date(Date.now() + 3 * 86_400_000);

    const response = await act({ action: 'retime_draft', draftId: draft.id, scheduledFor: at.toISOString(), timezone: 'Europe/Prague' });

    expect(response.status).toBe(200);
    expect((await reloadDraft(draft.id)).scheduledFor?.toISOString()).toBe(at.toISOString());
    expect(callsTo('editMessageText').at(-1)?.body.text).toContain('🕒 Scheduled for');
  });

  it('takes it off the schedule, leaving it waiting in the draft channel', async () => {
    const { draft } = await approveIntoDraft();
    await reply('завтра 9:00');

    expect((await act({ action: 'unschedule_draft', draftId: draft.id })).status).toBe(200);

    expect((await reloadDraft(draft.id)).status).toBe('waiting');
    expect(await list()).toEqual([]);
  });

  it('refuses a draft of a channel the reviewer does not review, and a time gone by', async () => {
    const { draft } = await approveIntoDraft();
    await reply('завтра 9:00');

    expect((await act({ action: 'unschedule_draft', draftId: draft.id }, STRANGER_ID)).status).toBe(401);
    expect(
      (await act({ action: 'retime_draft', draftId: draft.id, scheduledFor: new Date(Date.now() - 60_000).toISOString() })).status,
    ).toBe(400);
    expect((await reloadDraft(draft.id)).status).toBe('scheduled');
  });
});
