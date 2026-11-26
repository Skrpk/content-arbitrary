import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import { DEFAULT_WORKSPACE_ID, processedPosts, telegramMessages, userIdentities, users, workspaces, type ApprovalPayload } from '@/db/schema';
import { POST as previewRoute } from '@/app/api/telegram/webapp/preview/route';
import { GET as queueRoute, POST as decideRoute } from '@/app/api/telegram/webapp/queue/route';
import { telegramIdOfUser } from '@/lib/accounts/users';
import { ensureTestWorkspace, telegramOk, withEnv } from './helpers';

/**
 * Send to preview, from the Approve dialog: the post goes to the pressing
 * reviewer's own chat with the bot as it would go out, and nothing is decided.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

const BOT_TOKEN = '123456:AAHfakeTokenForTestsOnly';
const REVIEWER_ID = 555001;
const STRANGER_ID = 777002;
const CHANNEL_CHAT = '-1001000000001';
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
/** Set to make sendPhoto fail as Telegram does for someone who never started the bot. */
let notStarted: boolean;

beforeEach(async () => {
  if (!connectionString) return;
  calls = [];
  notStarted = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const method = String(input).split('/').pop()!;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ method, body });
      if (method === 'sendPhoto' && notStarted) {
        return new Response(
          JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" }),
          { status: 403 },
        );
      }
      if (method === 'sendPhoto') {
        return telegramOk({ message_id: PREVIEW_MESSAGE_ID, chat: { id: Number(body.chat_id) }, photo: [{ file_id: 'ONE', file_size: 1 }] });
      }
      return telegramOk(true);
    }),
  );
  await db.delete(telegramMessages);
  await db.delete(processedPosts);
  await db.delete(users);
  await ensureTestWorkspace(db);
  await db
    .update(workspaces)
    .set({ name: 'Vector', telegramChatId: CHANNEL_CHAT, telegramAdminChatId: String(REVIEWER_ID), postFooter: null })
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
  it('sends the post to the reviewer’s own chat with the bot as it would go out, and decides nothing, as often as asked', async () => {
    const post = await queuedPost();

    const response = await call(previewRoute, '/api/telegram/webapp/preview', { postId: post.id });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const sent = calls.filter((entry) => entry.method === 'sendPhoto');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ chat_id: String(REVIEWER_ID), photo: 'FILE_A', caption: 'A post', disable_notification: true });
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

  it('is only for the post’s own reviewer while it waits', async () => {
    const post = await queuedPost();
    expect((await call(previewRoute, '/api/telegram/webapp/preview', { postId: post.id }, { userId: STRANGER_ID })).status).toBe(401);

    await db.update(processedPosts).set({ status: 'published' }).where(eq(processedPosts.id, post.id));
    expect((await call(previewRoute, '/api/telegram/webapp/preview', { postId: post.id })).status).toBe(409);
    expect(calls.some((entry) => entry.method === 'sendPhoto')).toBe(false);
  });

  it('says to start the bot when Telegram will not let it write to the reviewer yet', async () => {
    const post = await queuedPost();
    notStarted = true;

    const response = await call(previewRoute, '/api/telegram/webapp/preview', { postId: post.id });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('press Start');
    expect((await reload(post.id)).status).toBe('awaiting_approval');
  });

  it('goes to the chat of the Telegram account the reviewer signed in with, and to none without one', async () => {
    // Signing in once makes the user, with their Telegram identity.
    expect((await call(queueRoute, '/api/telegram/webapp/queue', undefined, { method: 'GET' })).status).toBe(200);
    const [user] = await db.select().from(users);
    expect(await telegramIdOfUser(db, user!.id)).toBe(String(REVIEWER_ID));

    // An app store's reviewer signs in with a password, not Telegram: no chat to send to.
    await db.update(userIdentities).set({ provider: 'review', subject: 'demo' }).where(eq(userIdentities.userId, user!.id));
    expect(await telegramIdOfUser(db, user!.id)).toBeNull();
  });
});
