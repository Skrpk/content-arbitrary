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
import { GET, POST } from '@/app/api/telegram/webapp/schedule/route';
import { GET as runScheduler } from '@/app/api/cron/publish-scheduled/route';
import { ensureTestWorkspace, telegramOk, withEnv } from './helpers';

/**
 * The Schedule Mini App endpoint end to end, and the scheduler's cron route
 * guard.
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
const HOUR = 60 * 60 * 1000;

const routeEnv = {
  DATABASE_URL: connectionString,
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_CHAT_ID: '-1001000000001',
  TELEGRAM_ADMIN_CHAT_ID: String(REVIEWER_ID),
  TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(64),
  REQUIRE_APPROVAL: 'true',
  APP_BASE_URL: 'https://example.vercel.app',
  CRON_SECRET: 'test-cron-secret-value',
};

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

function load(postId: number, authorization = auth()) {
  return withEnv(routeEnv, () =>
    GET(
      new Request(`https://example.vercel.app/api/telegram/webapp/schedule?post=${postId}`, {
        headers: { authorization },
      }),
    ),
  );
}

function schedule(body: unknown, authorization = auth()) {
  return withEnv(routeEnv, () =>
    POST(
      new Request('https://example.vercel.app/api/telegram/webapp/schedule', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization },
        body: JSON.stringify(body),
      }),
    ),
  );
}

let calls: { method: string; body: Record<string, unknown> }[];

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
      approvalPayload: { method: 'sendPhoto', caption: 'Bear', items: [{ kind: 'photo', fileId: 'F' }] },
      originalCaption: 'Bear',
      caption: 'Bear',
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
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({
        method: String(input).split('/').pop()!,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
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
  await db.insert(workspaces).values({
    id: OTHER_WORKSPACE,
    name: 'second',
    telegramChatId: '-1002000000002',
    telegramAdminChatId: String(OTHER_REVIEWER_ID),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describeIfDb('GET /api/telegram/webapp/schedule', () => {
  it('describes a post in review, with no time yet', async () => {
    const post = await queuePost();
    const body = (await (await load(post.id)).json()) as Record<string, unknown>;

    expect(body).toMatchObject({ postId: post.id, caption: 'Bear', scheduledFor: null, maxDaysAhead: 365 });
  });

  it('gives the current time of a post already scheduled', async () => {
    const post = await queuePost();
    const at = new Date(Date.now() + HOUR);
    await schedule({ postId: post.id, scheduledFor: at.toISOString(), timezone: 'Europe/Kyiv' });

    const body = (await (await load(post.id)).json()) as Record<string, unknown>;

    expect(body).toMatchObject({ scheduledFor: at.toISOString(), timezone: 'Europe/Kyiv' });
  });

  it('refuses a validly signed user who reviews for nobody', async () => {
    const post = await queuePost();
    expect((await load(post.id, auth(STRANGER_ID))).status).toBe(401);
  });
});

describeIfDb('POST /api/telegram/webapp/schedule', () => {
  it('schedules the post and turns the review message into its schedule', async () => {
    const post = await queuePost();
    const at = new Date('2099-10-05T15:00:00Z');
    vi.setSystemTime(new Date('2099-10-01T00:00:00Z'));

    let response: Response;
    try {
      response = await schedule({ postId: post.id, scheduledFor: at.toISOString(), timezone: 'Europe/Kyiv' });
    } finally {
      vi.useRealTimers();
    }

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      scheduledFor: at.toISOString(),
      display: 'Mon 5 Oct, 18:00',
    });

    const after = await reload(post.id);
    expect(after.status).toBe('scheduled');
    expect(after.scheduledFor?.toISOString()).toBe(at.toISOString());
    expect(after.scheduledTimezone).toBe('Europe/Kyiv');
    expect(after.reviewedAt).toBeInstanceOf(Date);

    const [edit] = calls;
    expect(edit?.method).toBe('editMessageText');
    expect(edit?.body.message_id).toBe(CONTROL_MESSAGE_ID);
    expect(edit?.body.text).toContain('🕒 Scheduled for Mon 5 Oct, 18:00');
    const buttons = (edit?.body.reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard
      .flat()
      .map((button) => button.text);
    expect(buttons).toEqual(['⚡ Publish now', '↩️ Unschedule', '🕒 Change time', '✏️ Edit text']);
  });

  it('moves the time of a post already scheduled', async () => {
    const post = await queuePost();
    await schedule({ postId: post.id, scheduledFor: new Date(Date.now() + HOUR).toISOString() });
    const later = new Date(Date.now() + 5 * HOUR);

    const response = await schedule({ postId: post.id, scheduledFor: later.toISOString() });

    expect(response.status).toBe(200);
    expect((await reload(post.id)).scheduledFor?.toISOString()).toBe(later.toISOString());
  });

  it.each([
    ['in the past', () => new Date(Date.now() - 60 * 1000).toISOString(), 422],
    ['more than a year ahead', () => new Date(Date.now() + 366 * 24 * HOUR).toISOString(), 422],
    ['not a date', () => 'tomorrow-ish', 400],
  ])('refuses a time %s and leaves the post in review', async (_label, when, status) => {
    const post = await queuePost();

    const response = await schedule({ postId: post.id, scheduledFor: when() });

    expect(response.status).toBe(status);
    expect((await reload(post.id)).status).toBe('awaiting_approval');
  });

  it('keeps a zone it does not know as UTC', async () => {
    const post = await queuePost();

    await schedule({ postId: post.id, scheduledFor: new Date(Date.now() + HOUR).toISOString(), timezone: 'Mars/Olympus' });

    expect((await reload(post.id)).scheduledTimezone).toBe('UTC');
  });

  it('cannot schedule a post that has already been published', async () => {
    const post = await queuePost();
    await db.update(processedPosts).set({ status: 'published' }).where(eq(processedPosts.id, post.id));

    const response = await schedule({ postId: post.id, scheduledFor: new Date(Date.now() + HOUR).toISOString() });

    expect(response.status).toBe(409);
    expect((await reload(post.id)).scheduledFor).toBeNull();
  });

  it('lets neither a stranger nor another tenant\'s reviewer schedule', async () => {
    const post = await queuePost();
    const body = { postId: post.id, scheduledFor: new Date(Date.now() + HOUR).toISOString() };

    expect((await schedule(body, auth(STRANGER_ID))).status).toBe(401);
    expect((await schedule(body, auth(OTHER_REVIEWER_ID))).status).toBe(409);
    expect((await reload(post.id)).status).toBe('awaiting_approval');
    expect(calls).toHaveLength(0);
  });
});

describeIfDb('GET /api/cron/publish-scheduled', () => {
  const call = (authorization?: string) =>
    withEnv(routeEnv, () =>
      runScheduler(
        new Request('https://example.vercel.app/api/cron/publish-scheduled', {
          headers: authorization ? { authorization } : {},
        }),
      ),
    );

  it('refuses a call without the cron secret', async () => {
    expect((await call()).status).toBe(401);
    expect((await call('Bearer wrong')).status).toBe(401);
  });

  it('runs with it, and reports what it did', async () => {
    const response = await call('Bearer test-cron-secret-value');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      due: 0,
      published: 0,
      failed: 0,
      skipped: 0,
      returnedToReview: 0,
    });
  });
});
