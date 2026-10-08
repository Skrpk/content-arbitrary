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
import { GET, POST } from '@/app/api/telegram/webapp/reject/route';
import { REJECTION_NOTE_MAX_LENGTH } from '@/lib/sync/approval';
import { ensureTestWorkspace, telegramOk, withEnv } from './helpers';

/**
 * The "Other" Mini App endpoint end to end: signed request, tenant lookup and
 * the guarded rejection, through the route handlers themselves.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

const BOT_TOKEN = '123456:AAHfakeTokenForTestsOnly';
const REVIEWER_ID = 555001;
const STRANGER_ID = 424242;
const OTHER_WORKSPACE = 2;
const OTHER_REVIEWER_ID = 777002;
const CONTROL_MESSAGE_ID = 12;

const routeEnv = {
  DATABASE_URL: connectionString,
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_CHAT_ID: '-1001000000001',
  TELEGRAM_ADMIN_CHAT_ID: String(REVIEWER_ID),
  TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(64),
  REQUIRE_APPROVAL: 'true',
  APP_BASE_URL: 'https://example.vercel.app',
};

/** Sign init data the way Telegram does. */
function initDataFor(userId: number): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId, username: `u${userId}` }),
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

function load(postId: number, authorization = auth()) {
  return withEnv(routeEnv, () =>
    GET(
      new Request(`https://example.vercel.app/api/telegram/webapp/reject?post=${postId}`, {
        headers: { authorization },
      }),
    ),
  );
}

function submit(body: unknown, authorization = auth()) {
  return withEnv(routeEnv, () =>
    POST(
      new Request('https://example.vercel.app/api/telegram/webapp/reject', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization },
        body: JSON.stringify(body),
      }),
    ),
  );
}

let edits: Record<string, unknown>[];

async function queuePost(workspaceId = DEFAULT_WORKSPACE_ID) {
  const rows = await db
    .insert(processedPosts)
    .values({
      workspaceId,
      xPostId: String(1_750_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1e6))),
      xPostUrl: 'https://x.com/someone/status/1750000000000000001',
      xAuthorUsername: 'someone',
      status: 'awaiting_approval',
      adminChatId: String(REVIEWER_ID),
      adminMessageId: CONTROL_MESSAGE_ID,
      approvalPayload: { method: 'sendPhoto', caption: 'Bear &amp; cub', items: [{ kind: 'photo', fileId: 'F' }] },
      originalCaption: 'Bear &amp; cub',
      caption: 'Bear &amp; cub',
    })
    .returning();
  return rows[0]!;
}

async function reload(id: number) {
  return (await db.select().from(processedPosts).where(eq(processedPosts.id, id)))[0]!;
}

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
  edits = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      edits.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return telegramOk(true);
    }),
  );

  await db.delete(telegramMessages);
  await db.delete(processedPosts);
  await db.delete(syncState);
  await db.delete(sources);
  await ensureTestWorkspace(db);
  await db
    .update(workspaces)
    .set({ telegramChatId: '-1001000000001', telegramAdminChatId: String(REVIEWER_ID) })
    .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describeIfDb('GET /api/telegram/webapp/reject', () => {
  it('shows the reviewer what they are turning down, as plain text', async () => {
    const post = await queuePost();
    const response = await load(post.id);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      postId: post.id,
      sourceUsername: 'someone',
      sourceLabel: '@someone',
      caption: 'Bear & cub',
      noteLimit: REJECTION_NOTE_MAX_LENGTH,
    });
  });

  it('refuses a validly signed user who reviews for nobody', async () => {
    const post = await queuePost();
    expect((await load(post.id, auth(STRANGER_ID))).status).toBe(401);
  });

  it('refuses a request with no signature', async () => {
    const post = await queuePost();
    expect((await load(post.id, 'tma ')).status).toBe(401);
  });
});

describeIfDb('POST /api/telegram/webapp/reject', () => {
  it('rejects with reason other and the reviewer\'s own words', async () => {
    const post = await queuePost();

    const response = await submit({ postId: post.id, note: '  Paywalled, cannot verify.  ' });
    expect(response.status).toBe(200);

    const after = await reload(post.id);
    expect(after.status).toBe('rejected');
    expect(after.rejectionReason).toBe('other');
    expect(after.rejectionNote).toBe('Paywalled, cannot verify.');
    expect(after.reviewedAt).toBeInstanceOf(Date);
    expect(after.approvalPayload).toBeNull();
    expect(after.originalCaption).toBe('Bear &amp; cub');

    // The buttons in the chat give way to the recorded decision.
    expect(edits[0]?.message_id).toBe(CONTROL_MESSAGE_ID);
    expect(edits[0]?.text).toContain('Paywalled, cannot verify.');
    expect(edits[0]?.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it('stores no note rather than an empty one', async () => {
    const post = await queuePost();

    await submit({ postId: post.id, note: '   ' });
    const after = await reload(post.id);

    expect(after.rejectionReason).toBe('other');
    expect(after.rejectionNote).toBeNull();
  });

  it('refuses a note over the limit and leaves the post in the queue', async () => {
    const post = await queuePost();

    const response = await submit({ postId: post.id, note: 'x'.repeat(REJECTION_NOTE_MAX_LENGTH + 1) });

    expect(response.status).toBe(422);
    expect((await reload(post.id)).status).toBe('awaiting_approval');
  });

  it('keeps the first decision when submitted twice', async () => {
    const post = await queuePost();

    await submit({ postId: post.id, note: 'First' });
    const second = await submit({ postId: post.id, note: 'Second' });

    expect(second.status).toBe(409);
    expect((await reload(post.id)).rejectionNote).toBe('First');
  });

  it('records nothing on a post that was already published', async () => {
    const post = await queuePost();
    await db.update(processedPosts).set({ status: 'published' }).where(eq(processedPosts.id, post.id));

    const response = await submit({ postId: post.id, note: 'Too late' });

    expect(response.status).toBe(409);
    const after = await reload(post.id);
    expect(after.status).toBe('published');
    expect(after.rejectionReason).toBeNull();
    expect(after.rejectionNote).toBeNull();
  });

  it('lets a stranger not reject', async () => {
    const post = await queuePost();

    const response = await submit({ postId: post.id, note: 'mine now' }, auth(STRANGER_ID));

    expect(response.status).toBe(401);
    expect((await reload(post.id)).status).toBe('awaiting_approval');
  });

  it('lets another tenant\'s reviewer not reject', async () => {
    await db.insert(workspaces).values({
      id: OTHER_WORKSPACE,
      name: 'second',
      telegramChatId: '-1002000000002',
      telegramAdminChatId: String(OTHER_REVIEWER_ID),
    });
    const post = await queuePost();

    const response = await submit({ postId: post.id, note: 'not yours' }, auth(OTHER_REVIEWER_ID));

    expect(response.status).toBe(409);
    expect((await reload(post.id)).status).toBe('awaiting_approval');
    expect(edits).toHaveLength(0);
  });

  it('refuses a malformed body', async () => {
    const post = await queuePost();

    expect((await submit({ postId: String(post.id) })).status).toBe(400);
    expect((await reload(post.id)).status).toBe('awaiting_approval');
  });
});
