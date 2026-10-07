import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import {
  DEFAULT_WORKSPACE_ID,
  processedPosts,
  sources,
  syncState,
  telegramMessages,
  workspaces,
} from '@/db/schema';
import { POST as webhook } from '@/app/api/telegram/webhook/route';
import { GET as getCaption } from '@/app/api/telegram/webapp/caption/route';
import { POST as schedule } from '@/app/api/telegram/webapp/schedule/route';
import {
  GET as getSourceSettings,
  POST as setSourceSettings,
} from '@/app/api/telegram/webapp/sources/route';
import { ensureTestWorkspace, telegramOk, withEnv } from './helpers';

/**
 * One person reviewing two channels, through the real webhook and Mini App
 * routes: every post is acted on in its own channel, commands ask which
 * channel they mean, and a third tenant's posts and sources stay out of reach.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

const SECRET = 'a'.repeat(64);
const BOT_TOKEN = '123456:AAHfakeTokenForTestsOnly';
const REVIEWER = 555001;
const OTHER_REVIEWER = 777003;

const ALPHA = DEFAULT_WORKSPACE_ID;
const BETA = 2;
const GAMMA = 3;
const CHANNELS: Record<number, string> = {
  [ALPHA]: '-1001000000001',
  [BETA]: '-1002000000002',
  [GAMMA]: '-1003000000003',
};

const routeEnv = {
  DATABASE_URL: connectionString,
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_CHAT_ID: CHANNELS[ALPHA],
  TELEGRAM_ADMIN_CHAT_ID: String(REVIEWER),
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  REQUIRE_APPROVAL: 'true',
  APP_BASE_URL: 'https://example.vercel.app',
};

let calls: { method: string; body: Record<string, unknown> }[];
const callsTo = (method: string) => calls.filter((call) => call.method === method);

function stubNetwork() {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);

      // The X user lookup behind /addsource.
      if (url.includes('/2/users/by/username/')) {
        const username = url.split('/2/users/by/username/')[1]!.split('?')[0]!;
        return new Response(JSON.stringify({ data: { id: '33836629', username } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      const method = url.split('/').pop()!;
      calls.push({ method, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      if (method === 'sendPhoto') {
        return telegramOk({ message_id: 900, chat: { id: -1 }, photo: [{ file_id: 'X', file_size: 1 }] });
      }
      if (method === 'sendMessage') return telegramOk({ message_id: 901, chat: { id: -1 } });
      return telegramOk(true);
    }),
  );
}

function send(update: Record<string, unknown>) {
  return withEnv(routeEnv, () =>
    webhook(
      new Request('https://example.vercel.app/api/telegram/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
        body: JSON.stringify({ update_id: 1, ...update }),
      }),
    ),
  );
}

const press = (data: string, fromId = REVIEWER) =>
  send({
    callback_query: {
      id: 'cb',
      from: { id: fromId },
      data,
      message: { message_id: 12, chat: { id: fromId } },
    },
  });

const command = (text: string, fromId = REVIEWER) =>
  send({
    message: { message_id: 5, from: { id: fromId }, chat: { id: fromId, type: 'private' }, text },
  });

/** The latest bot reply, with its buttons' data. */
function lastReply() {
  const reply = callsTo('sendMessage').at(-1)?.body;
  const buttons = (
    (reply?.reply_markup as { inline_keyboard?: { text: string; callback_data?: string }[][] })
      ?.inline_keyboard ?? []
  ).flat();
  return { text: String(reply?.text ?? ''), buttons };
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

const auth = (userId = REVIEWER) => ({ authorization: `tma ${initDataFor(userId)}` });

async function queuePost(workspaceId: number) {
  const rows = await db
    .insert(processedPosts)
    .values({
      workspaceId,
      xPostId: String(1_750_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1e6))),
      xPostUrl: 'https://x.com/someone/status/1750000000000000001',
      xAuthorUsername: 'someone',
      status: 'awaiting_approval',
      adminChatId: String(workspaceId === GAMMA ? OTHER_REVIEWER : REVIEWER),
      adminMessageId: 12,
      approvalPayload: { method: 'sendPhoto', caption: 'Hi', items: [{ kind: 'photo', fileId: 'F' }] },
      originalCaption: 'Hi',
      caption: 'Hi',
    })
    .returning();
  return rows[0]!;
}

async function reload(id: number) {
  return (await db.select().from(processedPosts).where(eq(processedPosts.id, id)))[0]!;
}

const sourcesOf = async (workspaceId: number) =>
  (await db.select().from(sources).where(eq(sources.workspaceId, workspaceId))).map(
    (source) => source.username,
  );

beforeAll(async () => {
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
  await db.delete(telegramMessages);
  await db.delete(processedPosts);
  await db.delete(syncState);
  await db.delete(sources);
  await ensureTestWorkspace(db);
  await db
    .update(workspaces)
    .set({ name: 'Alpha', telegramChatId: CHANNELS[ALPHA], telegramAdminChatId: String(REVIEWER) })
    .where(eq(workspaces.id, ALPHA));
  await db.insert(workspaces).values([
    { id: BETA, name: 'Beta', telegramChatId: CHANNELS[BETA], telegramAdminChatId: String(REVIEWER) },
    {
      id: GAMMA,
      name: 'Gamma',
      telegramChatId: CHANNELS[GAMMA],
      telegramAdminChatId: String(OTHER_REVIEWER),
    },
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describeIfDb('reviewing posts of two channels', () => {
  it.each([
    ['Alpha', ALPHA],
    ['Beta', BETA],
  ])('publishes a post of %s to its own channel', async (_name, workspaceId) => {
    const post = await queuePost(workspaceId);

    await press(`ap:${post.id}`);

    expect(callsTo('sendPhoto').map((call) => call.body.chat_id)).toEqual([CHANNELS[workspaceId]]);
    expect((await reload(post.id)).status).toBe('published');
  });

  it('rejects a post of the second channel', async () => {
    const post = await queuePost(BETA);

    await press(`rr:${post.id}:too_minor`);

    const after = await reload(post.id);
    expect(after.status).toBe('rejected');
    expect(after.rejectionReason).toBe('too_minor');
  });

  it('still cannot touch a channel it does not review', async () => {
    const post = await queuePost(GAMMA);

    await press(`ap:${post.id}`);
    await press(`rr:${post.id}:other`);

    expect(callsTo('sendPhoto')).toHaveLength(0);
    expect((await reload(post.id)).status).toBe('awaiting_approval');
    expect(callsTo('answerCallbackQuery').at(-1)?.body.text).toBe(
      'Not awaiting review (status: unknown).',
    );
  });

  it('labels the review message with its channel when it is put back after Unschedule', async () => {
    const post = await queuePost(BETA);
    await db
      .update(processedPosts)
      .set({ status: 'scheduled', scheduledFor: new Date(Date.now() + 3_600_000) })
      .where(eq(processedPosts.id, post.id));

    await press(`us:${post.id}`);

    expect(callsTo('editMessageText')[0]?.body.text).toMatch(/^📢 Beta\n/);
  });
});

describeIfDb('source commands for two channels', () => {
  it('asks which channel to add a source to', async () => {
    await command('/addsource @karpathy');

    const { text, buttons } = lastReply();
    expect(text).toBe('Add <b>@karpathy</b> to which channel?');
    expect(buttons).toEqual([
      { text: '📢 Alpha', callback_data: `wc:a:${ALPHA}:karpathy` },
      { text: '📢 Beta', callback_data: `wc:a:${BETA}:karpathy` },
    ]);
    expect(await sourcesOf(ALPHA)).toEqual([]);
    expect(await sourcesOf(BETA)).toEqual([]);
  });

  it('adds it to the channel picked, and says so in place of the question', async () => {
    await press(`wc:a:${BETA}:karpathy`);

    expect(await sourcesOf(BETA)).toEqual(['karpathy']);
    expect(await sourcesOf(ALPHA)).toEqual([]);

    const [answer] = callsTo('editMessageText');
    expect(answer?.body.text).toMatch(/^📢 Beta\n\n✅ <b>Source added<\/b>/);
    expect(answer?.body.reply_markup).toEqual({
      inline_keyboard: [[{ text: '⚙️ Settings', web_app: { url: 'https://example.vercel.app/settings' } }]],
    });
  });

  it('refuses a channel button for a channel it does not review', async () => {
    await press(`wc:a:${GAMMA}:karpathy`);

    expect(await sourcesOf(GAMMA)).toEqual([]);
    expect(callsTo('editMessageText')[0]?.body.text).toBe('⚠️ That channel is not one of yours.');
  });

  it('ignores a remove button left from before removing moved to /sourcestats', async () => {
    await db.insert(sources).values({ workspaceId: ALPHA, externalId: '33836629', username: 'karpathy' });

    await press(`wc:r:${ALPHA}:karpathy`);

    expect(await sourcesOf(ALPHA)).toEqual(['karpathy']);
  });
});

describeIfDb('Mini Apps for two channels', () => {
  it('opens the editor for a post of either channel, but not of a third', async () => {
    const beta = await queuePost(BETA);
    const gamma = await queuePost(GAMMA);
    const open = (postId: number) =>
      withEnv(routeEnv, () =>
        getCaption(
          new Request(`https://example.vercel.app/api/telegram/webapp/caption?post=${postId}`, {
            headers: auth(),
          }),
        ),
      );

    expect((await open(beta.id)).status).toBe(200);
    expect((await open(gamma.id)).status).toBe(404);
  });

  it('schedules a post of the second channel, naming the channel on its review message', async () => {
    const post = await queuePost(BETA);

    const response = await withEnv(routeEnv, () =>
      schedule(
        new Request('https://example.vercel.app/api/telegram/webapp/schedule', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth() },
          body: JSON.stringify({
            postId: post.id,
            scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect((await reload(post.id)).status).toBe('scheduled');
    expect(callsTo('editMessageText')[0]?.body.text).toContain('📢 Beta');
  });

  it('lists the settings of both channels and changes either, but not a third', async () => {
    const [, beta, gamma] = await db
      .insert(sources)
      .values([
        { workspaceId: ALPHA, externalId: '1', username: 'alpha_src' },
        { workspaceId: BETA, externalId: '2', username: 'beta_src' },
        { workspaceId: GAMMA, externalId: '3', username: 'gamma_src' },
      ])
      .returning();

    const listed = (await (
      await withEnv(routeEnv, () =>
        getSourceSettings(
          new Request('https://example.vercel.app/api/telegram/webapp/sources', { headers: auth() }),
        ),
      )
    ).json()) as { channels: { name: string; sources: { username: string }[] }[] };
    expect(listed.channels.map((channel) => [channel.name, channel.sources.map((s) => s.username)])).toEqual([
      ['Alpha', ['alpha_src']],
      ['Beta', ['beta_src']],
    ]);

    const change = (sourceId: number) =>
      withEnv(routeEnv, () =>
        setSourceSettings(
          new Request('https://example.vercel.app/api/telegram/webapp/sources', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...auth() },
            body: JSON.stringify({ sourceId, includeTextOnly: true }),
          }),
        ),
      );

    expect((await change(beta!.id)).status).toBe(200);
    expect((await change(gamma!.id)).status).toBe(404);
  });
});
