import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import {
  assistantRequests,
  DEFAULT_WORKSPACE_ID,
  processedPosts,
  threadsAccounts,
  users,
  workspaces,
  type ApprovalPayload,
} from '@/db/schema';
import type { CompletionRequest } from '@/lib/radar/providers/types';
import { initialRichDocument } from '@/lib/rich/document';
import { threadsContentFor } from '@/lib/threads/deliveries';
import { encryptToken } from '@/lib/threads/token-crypto';
import { ensureTestWorkspace, withEnv } from './helpers';

/**
 * A post's own Threads text, end to end: the editor's Threads tab loading and
 * saving it, what the queue's Publish dialog is told, the text the post then
 * goes to Threads with, and "Adapt for Threads" with the model replaced.
 */

const answers: string[] = [];
const asked: CompletionRequest<unknown>[] = [];

vi.mock('@/lib/radar/providers', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/radar/providers')>();
  const fake = {
    name: 'openai',
    model: 'gpt-6-luna',
    async complete(request: CompletionRequest<unknown>) {
      asked.push(request);
      const text = answers.shift();
      if (text === undefined) throw new Error('no answer scripted');
      return { output: { text }, usage: { inputTokens: 120, outputTokens: 40 } };
    },
  };
  return {
    ...original,
    createRadarProvider: (env: Parameters<typeof original.createRadarProvider>[0]) => (env.OPENAI_API_KEY ? fake : null),
  };
});

const richRoute = await import('@/app/api/telegram/webapp/rich/route');
const { GET: queueRoute } = await import('@/app/api/telegram/webapp/queue/route');
const { POST: adaptRoute } = await import('@/app/api/telegram/webapp/threads-adapt/route');

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

const BOT_TOKEN = '123456:AAHfakeTokenForTestsOnly';
const REVIEWER_ID = 555001;
const BASE = 'https://example.vercel.app/api/telegram/webapp';

const env = {
  DATABASE_URL: connectionString,
  DRY_RUN: 'false',
  REQUIRE_APPROVAL: 'true',
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(64),
  APP_BASE_URL: 'https://example.vercel.app',
  OPENAI_API_KEY: 'sk-test',
  ASSISTANT_DAILY_LIMIT: '2',
};

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

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
  answers.length = 0;
  asked.length = 0;
  await db.delete(assistantRequests);
  await db.delete(threadsAccounts);
  await db.delete(processedPosts);
  await db.delete(users);
  await ensureTestWorkspace(db);
  await db
    .update(workspaces)
    .set({ name: 'VECTOR', telegramChatId: '-1003906212630', telegramAdminChatId: String(REVIEWER_ID), language: 'uk', postFooter: null })
    .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
});

function initData(): string {
  const fields: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: REVIEWER_ID }) };
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const params = new URLSearchParams(fields);
  params.set('hash', createHmac('sha256', secretKey).update(dataCheckString).digest('hex'));
  return params.toString();
}

function call(handler: (request: Request) => Promise<Response>, path: string, init: { method?: string; body?: unknown } = {}, extraEnv: Record<string, string | undefined> = {}) {
  return withEnv({ ...env, ...extraEnv }, () =>
    handler(
      new Request(`${BASE}${path}`, {
        method: init.method ?? 'GET',
        headers: { 'content-type': 'application/json', authorization: `tma ${initData()}` },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      }),
    ),
  );
}

const LONG = `${'Webb has traced a record radio burst to its home galaxy. '.repeat(12)}`.trim();

async function queuedPost(caption = LONG) {
  const payload: ApprovalPayload = { method: 'sendPhoto', caption, items: [{ kind: 'photo', fileId: 'FILE_A' }] };
  const [row] = await db
    .insert(processedPosts)
    .values({
      workspaceId: DEFAULT_WORKSPACE_ID,
      externalId: String(1_750_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1e6))),
      xPostUrl: 'https://x.com/nasa/status/1',
      xAuthorUsername: 'nasa',
      status: 'awaiting_approval',
      approvalPayload: payload,
      reviewQueuedAt: new Date(),
      originalCaption: caption,
      caption,
    })
    .returning();
  return row!;
}

async function connectThreads() {
  await db.insert(threadsAccounts).values({
    workspaceId: DEFAULT_WORKSPACE_ID,
    threadsUserId: '17841405793187218',
    username: 'vector',
    accessTokenEncrypted: encryptToken('long-token', 'threads-app-secret-for-tests-0123456789'),
    tokenExpiresAt: new Date(Date.now() + 50 * 24 * 3600 * 1000),
    tokenRefreshedAt: new Date(),
    scopes: ['threads_basic', 'threads_content_publish'],
  });
}

const reload = async (id: number) => (await db.select().from(processedPosts).where(eq(processedPosts.id, id)))[0]!;
const save = (body: Record<string, unknown>) => call(richRoute.POST, '/rich', { method: 'POST', body });

async function queueItem(id: number) {
  const body = (await (await call(queueRoute, '/queue')).json()) as {
    channels: { threads: boolean; items: { id: number; threads: unknown }[] }[];
  };
  return body.channels[0]!.items.find((item) => item.id === id)!;
}

describeIfDb('the editor’s Threads tab', () => {
  it('is offered only to a channel with a Threads account, with Adapt when the assistant is set up', async () => {
    const post = await queuedPost();
    const without = (await (await call(richRoute.GET, `/rich?post=${post.id}`)).json()) as { threads: unknown };
    expect(without.threads).toBeNull();

    await connectThreads();
    const withAccount = (await (await call(richRoute.GET, `/rich?post=${post.id}`)).json()) as { threads: unknown };
    expect(withAccount.threads).toEqual({ text: null, adapt: true });
    const noAssistant = (await (await call(richRoute.GET, `/rich?post=${post.id}`, {}, { OPENAI_API_KEY: undefined })).json()) as {
      threads: unknown;
    };
    expect(noAssistant.threads).toEqual({ text: null, adapt: false });
  });

  it('saves the post’s own Threads text without touching its Telegram post, and clears it again', async () => {
    await connectThreads();
    const post = await queuedPost();

    expect((await save({ postId: post.id, threadsText: '  Webb traced a record radio burst home. 🔭  ' })).status).toBe(200);
    let row = await reload(post.id);
    expect(row.threadsText).toBe('Webb traced a record radio burst home. 🔭');
    expect(row.richDoc).toBeNull();
    expect(row.captionEditedAt).toBeNull();
    const loaded = (await (await call(richRoute.GET, `/rich?post=${post.id}`)).json()) as { threads: { text: string } };
    expect(loaded.threads.text).toBe('Webb traced a record radio burst home. 🔭');

    // Saving the Telegram post alone keeps the Threads text.
    const doc = initialRichDocument({ text: 'A new Telegram text', mediaCount: 1 });
    expect((await save({ postId: post.id, doc })).status).toBe(200);
    row = await reload(post.id);
    expect(row.richDoc).not.toBeNull();
    expect(row.threadsText).toBe('Webb traced a record radio burst home. 🔭');

    expect((await save({ postId: post.id, threadsText: null })).status).toBe(200);
    expect((await reload(post.id)).threadsText).toBeNull();
  });

  it('refuses a Threads text that is empty, too long, or for a channel with no Threads account', async () => {
    const post = await queuedPost();
    expect((await save({ postId: post.id, threadsText: 'Fine' })).status).toBe(422);

    await connectThreads();
    expect((await save({ postId: post.id, threadsText: '   ' })).status).toBe(422);
    const tooLong = await save({ postId: post.id, threadsText: 'a'.repeat(501) });
    expect(tooLong.status).toBe(422);
    expect(((await tooLong.json()) as { error: string }).error).toContain('500');
    // An emoji counts as its bytes, as Threads counts it.
    expect((await save({ postId: post.id, threadsText: '🔭'.repeat(126) })).status).toBe(422);
    expect((await save({ postId: post.id })).status).toBe(400);
    expect((await reload(post.id)).threadsText).toBeNull();
  });
});

describeIfDb('what the Publish dialog is told, and what Threads gets', () => {
  it('says a long Telegram text is shortened for Threads, and an own text is the post’s own', async () => {
    await connectThreads();
    const post = await queuedPost();

    expect(await queueItem(post.id)).toMatchObject({ threads: { own: false, cut: true, attached: false } });

    await save({ postId: post.id, threadsText: 'Webb traced it home.' });
    expect(await queueItem(post.id)).toMatchObject({ threads: { text: 'Webb traced it home.', own: true, cut: false } });

    // The post goes to Threads with its own text, and its picture all the same.
    const row = await reload(post.id);
    const content = await threadsContentFor(db, { row, payload: row.approvalPayload! });
    expect(content).toMatchObject({ text: 'Webb traced it home.', media: [{ kind: 'photo', telegramFileId: 'FILE_A' }] });
  });

  it('keeps sending a post with no Threads text of its own with the Telegram text', async () => {
    const post = await queuedPost('<b>Webb</b> finds water');
    const row = await reload(post.id);
    expect((await threadsContentFor(db, { row, payload: row.approvalPayload! })).text).toBe('Webb finds water');
    expect(await queueItem(post.id)).toMatchObject({ threads: { text: 'Webb finds water', own: false, cut: false } });
  });
});

describeIfDb('Adapt for Threads', () => {
  const adapt = (body: Record<string, unknown>, extraEnv: Record<string, string | undefined> = {}) =>
    call(adaptRoute, '/threads-adapt', { method: 'POST', body }, extraEnv);

  it('hands back the model’s Threads post, saves nothing, and records what it cost', async () => {
    await connectThreads();
    const post = await queuedPost();
    answers.push('Webb простежив рекордний радіосплеск до рідної галактики. 🔭');

    const response = await adapt({ postId: post.id, text: LONG });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'Webb простежив рекордний радіосплеск до рідної галактики. 🔭' });
    expect(asked[0]!.instructions).toContain('Write in Ukrainian.');
    expect(asked[0]!.input).toContain('Webb has traced a record radio burst');

    expect((await reload(post.id)).threadsText).toBeNull();
    const [request] = await db.select().from(assistantRequests);
    expect(request).toMatchObject({ processedPostId: post.id, promptVersion: 'threads-adapt-v1', status: 'ok', inputTokens: 120, outputTokens: 40 });
  });

  it('cuts an answer too long for Threads, rather than hand back one that does not fit', async () => {
    await connectThreads();
    const post = await queuedPost();
    answers.push('Too long. '.repeat(80));
    const { text } = (await (await adapt({ postId: post.id, text: LONG })).json()) as { text: string };
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text.endsWith('…')).toBe(true);
  });

  it('is refused with no assistant, with no Threads account, and past the daily limit', async () => {
    const post = await queuedPost();
    expect((await adapt({ postId: post.id, text: LONG })).status).toBe(422);
    await connectThreads();
    expect((await adapt({ postId: post.id, text: LONG }, { OPENAI_API_KEY: undefined })).status).toBe(503);

    answers.push('One.', 'Two.');
    expect((await adapt({ postId: post.id, text: LONG })).status).toBe(200);
    expect((await adapt({ postId: post.id, text: LONG })).status).toBe(200);
    expect((await adapt({ postId: post.id, text: LONG })).status).toBe(429);
  });

  it('says so when the model fails, and records the failure', async () => {
    await connectThreads();
    const post = await queuedPost();
    const response = await adapt({ postId: post.id, text: LONG });
    expect(response.status).toBe(502);
    const [request] = await db.select().from(assistantRequests);
    expect(request).toMatchObject({ status: 'failed', promptVersion: 'threads-adapt-v1' });
  });
});
