import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  type ApprovalPayload,
} from '@/db/schema';
import { TelegramClient } from '@/lib/telegram/client';
import { publishDueScheduledPosts } from '@/lib/sync/publish-scheduled';
import {
  claimScheduledForPublishing,
  schedulePost,
  unschedulePost,
  updateApprovalCaption,
} from '@/lib/sync/repository';
import { createTestLogger, ensureTestWorkspace, instantSleep, telegramError, telegramOk, withEnv } from './helpers';

/**
 * The scheduler against a real database: posts approved for later are
 * published when due, exactly once, and a post that keeps failing goes back to
 * the reviewer instead of being retried forever.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

const ADMIN_CHAT = '555001';
const CHANNEL_CHAT = '-1001000000001';
const CONTROL_MESSAGE_ID = 12;

const env = {
  REQUIRE_APPROVAL: 'true',
  TELEGRAM_ADMIN_CHAT_ID: ADMIN_CHAT,
  TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(64),
  TELEGRAM_CHAT_ID: CHANNEL_CHAT,
  APP_BASE_URL: 'https://example.vercel.app',
  MAX_RETRY_ATTEMPTS: '3',
};

const MINUTE = 60 * 1000;

function makeTelegram(options?: { failSends?: boolean }) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const method = String(input).split('/').pop()!;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ method, body });

    if (options?.failSends && method.startsWith('send')) {
      return telegramError(400, 'Bad Request: chat not found');
    }
    if (method === 'sendPhoto') {
      return telegramOk({ message_id: 700, chat: { id: -1 }, photo: [{ file_id: 'X', file_size: 1 }] });
    }
    if (method === 'sendMessage') return telegramOk({ message_id: 701, chat: { id: -1 } });
    return telegramOk(true);
  });

  const client = new TelegramClient({
    token: '123456:TEST',
    baseUrl: 'https://api.telegram.example',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    attempts: 1,
    sleep: instantSleep,
  });

  return { client, calls, sends: () => calls.filter((call) => call.method.startsWith('send')) };
}

const photoPayload = (caption: string): ApprovalPayload => ({
  method: 'sendPhoto',
  caption,
  items: [{ kind: 'photo', fileId: 'FILE_A' }],
});

async function queuePost(options?: { caption?: string; payload?: ApprovalPayload }) {
  const caption = options?.caption ?? 'A';
  const rows = await db
    .insert(processedPosts)
    .values({
      workspaceId: DEFAULT_WORKSPACE_ID,
      xPostId: String(1_750_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1e6))),
      xPostUrl: 'https://x.com/someone/status/1750000000000000001',
      xAuthorUsername: 'someone',
      status: 'awaiting_approval',
      adminChatId: ADMIN_CHAT,
      adminMessageId: CONTROL_MESSAGE_ID,
      approvalPayload: options?.payload ?? photoPayload(caption),
      originalCaption: caption,
      caption,
    })
    .returning();
  return rows[0]!;
}

async function scheduleAt(id: number, at: Date) {
  const result = await schedulePost(db, {
    id,
    workspaceId: DEFAULT_WORKSPACE_ID,
    scheduledFor: at,
    timezone: 'Europe/Kyiv',
  });
  expect(result.scheduled).toBe(true);
  return result.row!;
}

async function reload(id: number) {
  return (await db.select().from(processedPosts).where(eq(processedPosts.id, id)))[0]!;
}

const run = (telegram: ReturnType<typeof makeTelegram>, now = new Date()) =>
  withEnv(env, (resolvedEnv) =>
    publishDueScheduledPosts({
      db,
      env: resolvedEnv,
      client: telegram.client,
      logger: createTestLogger(),
      now,
      sleep: instantSleep,
    }),
  );

beforeAll(async () => {
  if (!connectionString) return;
  sql = postgres(connectionString, { max: 6, prepare: false });
  db = drizzle(sql, { schema });
});

afterAll(async () => {
  if (sql) await sql.end();
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

describeIfDb('scheduling a post', () => {
  it('records the time, the zone and the decision', async () => {
    const post = await queuePost();
    const at = new Date(Date.now() + 60 * MINUTE);

    await scheduleAt(post.id, at);
    const after = await reload(post.id);

    expect(after.status).toBe('scheduled');
    expect(after.scheduledFor?.toISOString()).toBe(at.toISOString());
    expect(after.scheduledTimezone).toBe('Europe/Kyiv');
    expect(after.reviewedAt).toBeInstanceOf(Date);
  });

  it('keeps the first decision time when the post is retimed', async () => {
    const post = await queuePost();
    await scheduleAt(post.id, new Date(Date.now() + 60 * MINUTE));
    const decidedAt = (await reload(post.id)).reviewedAt!;

    const later = new Date(Date.now() + 120 * MINUTE);
    await scheduleAt(post.id, later);
    const after = await reload(post.id);

    expect(after.scheduledFor?.toISOString()).toBe(later.toISOString());
    expect(after.reviewedAt?.toISOString()).toBe(decidedAt.toISOString());
  });

  it('cannot schedule a post that is already published', async () => {
    const post = await queuePost();
    await db.update(processedPosts).set({ status: 'published' }).where(eq(processedPosts.id, post.id));

    const result = await schedulePost(db, {
      id: post.id,
      workspaceId: DEFAULT_WORKSPACE_ID,
      scheduledFor: new Date(Date.now() + MINUTE),
      timezone: 'UTC',
    });

    expect(result).toEqual({ scheduled: false, currentStatus: 'published' });
  });

  it('cannot schedule another tenant\'s post', async () => {
    const post = await queuePost();

    const result = await schedulePost(db, {
      id: post.id,
      workspaceId: 999,
      scheduledFor: new Date(Date.now() + MINUTE),
      timezone: 'UTC',
    });

    expect(result.scheduled).toBe(false);
    expect((await reload(post.id)).status).toBe('awaiting_approval');
  });

  it('goes back to review, undecided, when unscheduled', async () => {
    const post = await queuePost();
    await scheduleAt(post.id, new Date(Date.now() + 60 * MINUTE));

    const result = await unschedulePost(db, { id: post.id, workspaceId: DEFAULT_WORKSPACE_ID });
    const after = await reload(post.id);

    expect(result.unscheduled).toBe(true);
    expect(after.status).toBe('awaiting_approval');
    expect(after.scheduledFor).toBeNull();
    expect(after.scheduledTimezone).toBeNull();
    expect(after.reviewedAt).toBeNull();
  });

  it('can still be edited while it waits', async () => {
    const post = await queuePost({ caption: 'A' });
    await scheduleAt(post.id, new Date(Date.now() + 60 * MINUTE));

    const result = await updateApprovalCaption(db, {
      id: post.id,
      workspaceId: DEFAULT_WORKSPACE_ID,
      caption: 'B',
    });

    expect(result.updated).toBe(true);
    const after = await reload(post.id);
    expect(after.status).toBe('scheduled');
    expect(after.caption).toBe('B');
    expect(after.originalCaption).toBe('A');
  });
});

describeIfDb('the scheduler', () => {
  it('publishes a due post to the channel and tells the reviewer', async () => {
    const post = await queuePost({ caption: 'Bear at dawn' });
    const at = new Date(Date.now() - MINUTE);
    await db
      .update(processedPosts)
      .set({ status: 'scheduled', scheduledFor: at, scheduledTimezone: 'Europe/Kyiv', reviewedAt: new Date() })
      .where(eq(processedPosts.id, post.id));
    const telegram = makeTelegram();

    const summary = await run(telegram);

    expect(summary).toMatchObject({ due: 1, published: 1, failed: 0 });
    expect(telegram.sends()).toEqual([
      expect.objectContaining({ method: 'sendPhoto', body: expect.objectContaining({ chat_id: CHANNEL_CHAT, caption: 'Bear at dawn' }) }),
    ]);

    const after = await reload(post.id);
    expect(after.status).toBe('published');
    expect(after.telegramMessageId).toBe(700);
    // The plan stays on record, to compare with when it actually went out.
    expect(after.scheduledFor?.toISOString()).toBe(at.toISOString());

    const notice = telegram.calls.find((call) => call.method === 'editMessageText');
    expect(notice?.body.message_id).toBe(CONTROL_MESSAGE_ID);
    expect(notice?.body.text).toContain('Published as scheduled');
  });

  it('leaves a post whose time has not come', async () => {
    const post = await queuePost();
    await scheduleAt(post.id, new Date(Date.now() + 10 * MINUTE));
    const telegram = makeTelegram();

    const summary = await run(telegram);

    expect(summary.due).toBe(0);
    expect(telegram.calls).toHaveLength(0);
    expect((await reload(post.id)).status).toBe('scheduled');
  });

  it('publishes it once its time comes', async () => {
    const post = await queuePost();
    await scheduleAt(post.id, new Date(Date.now() + 10 * MINUTE));
    const telegram = makeTelegram();

    await run(telegram, new Date(Date.now() + 11 * MINUTE));

    expect((await reload(post.id)).status).toBe('published');
  });

  it('publishes the text as last edited, not as it was when scheduled', async () => {
    const post = await queuePost({ caption: 'A' });
    await scheduleAt(post.id, new Date(Date.now() + MINUTE));
    await updateApprovalCaption(db, { id: post.id, workspaceId: DEFAULT_WORKSPACE_ID, caption: 'C' });
    const telegram = makeTelegram();

    await run(telegram, new Date(Date.now() + 2 * MINUTE));

    expect(telegram.sends()[0]?.body.caption).toBe('C');
  });

  it('publishes a text-only post as a text message', async () => {
    const post = await queuePost({
      payload: { method: 'sendMessage', caption: 'Just words', items: [] },
      caption: 'Just words',
    });
    await scheduleAt(post.id, new Date(Date.now() + MINUTE));
    const telegram = makeTelegram();

    await run(telegram, new Date(Date.now() + 2 * MINUTE));

    expect(telegram.sends().map((call) => call.method)).toEqual(['sendMessage']);
    expect(telegram.sends()[0]?.body).toMatchObject({ chat_id: CHANNEL_CHAT, text: 'Just words' });
  });

  it('publishes a post once even when two runs overlap', async () => {
    const post = await queuePost();
    await scheduleAt(post.id, new Date(Date.now() + MINUTE));
    const telegram = makeTelegram();
    const later = new Date(Date.now() + 2 * MINUTE);

    const [first, second] = await Promise.all([run(telegram, later), run(telegram, later)]);

    expect(first.published + second.published).toBe(1);
    expect(telegram.sends()).toHaveLength(1);
    expect(await db.select().from(telegramMessages)).toHaveLength(1);
  });

  /**
   * The race the overlapping-runs test can only hope to hit, made certain:
   * once one run holds the post, a second claim for it gets nothing.
   */
  it('lets only one claim take a due post', async () => {
    const post = await queuePost();
    await scheduleAt(post.id, new Date(Date.now() + MINUTE));
    const later = new Date(Date.now() + 2 * MINUTE);

    const first = await claimScheduledForPublishing(db, { id: post.id, now: later });
    const second = await claimScheduledForPublishing(db, { id: post.id, now: later });

    expect(first?.status).toBe('processing');
    expect(second).toBeNull();
  });

  it('does not take a post retimed after it was listed', async () => {
    const post = await queuePost();
    await scheduleAt(post.id, new Date(Date.now() + 10 * MINUTE));

    // Listed as due at +11 min, then moved to +60 min before the claim lands.
    expect(await claimScheduledForPublishing(db, { id: post.id, now: new Date(Date.now() + 5 * MINUTE) })).toBeNull();
    expect((await reload(post.id)).status).toBe('scheduled');
  });

  it('does not take a post unscheduled after it was listed', async () => {
    const post = await queuePost();
    await scheduleAt(post.id, new Date(Date.now() + MINUTE));
    await unschedulePost(db, { id: post.id, workspaceId: DEFAULT_WORKSPACE_ID });

    expect(
      await claimScheduledForPublishing(db, { id: post.id, now: new Date(Date.now() + 2 * MINUTE) }),
    ).toBeNull();
    expect((await reload(post.id)).status).toBe('awaiting_approval');
  });

  it('keeps a failed post on the schedule and tries again next minute', async () => {
    const post = await queuePost();
    await scheduleAt(post.id, new Date(Date.now() + MINUTE));

    const summary = await run(makeTelegram({ failSends: true }), new Date(Date.now() + 2 * MINUTE));

    expect(summary).toMatchObject({ published: 0, failed: 1, returnedToReview: 0 });
    const after = await reload(post.id);
    expect(after.status).toBe('scheduled');
    expect(after.retryCount).toBe(1);
    expect(after.errorMessage).toContain('chat not found');

    await run(makeTelegram(), new Date(Date.now() + 3 * MINUTE));
    expect((await reload(post.id)).status).toBe('published');
  });

  it('gives a post that keeps failing back to the reviewer, with the buttons to decide again', async () => {
    const post = await queuePost();
    await scheduleAt(post.id, new Date(Date.now() + MINUTE));
    const failing = makeTelegram({ failSends: true });

    // MAX_RETRY_ATTEMPTS is 3 here.
    for (let minute = 2; minute <= 4; minute += 1) {
      await run(failing, new Date(Date.now() + minute * MINUTE));
    }

    const after = await reload(post.id);
    expect(after.status).toBe('awaiting_approval');
    expect(after.scheduledFor).toBeNull();
    expect(after.reviewedAt).toBeNull();
    expect(after.errorMessage).toContain('chat not found');

    const notice = failing.calls.filter((call) => call.method === 'editMessageText').at(-1);
    expect(notice?.body.text).toContain('Scheduled publishing failed 3 times');
    const buttons = (notice?.body.reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard
      .flat()
      .map((button) => button.text);
    expect(buttons).toEqual(['✅ Approve', '🚫 Reject', '🕒 Schedule', '✏️ Edit text']);

    // Nothing more is attempted once it is back in review.
    const quiet = makeTelegram();
    await run(quiet, new Date(Date.now() + 10 * MINUTE));
    expect(quiet.calls).toHaveLength(0);
  });

  it('starts each schedule with a fresh count of attempts', async () => {
    const post = await queuePost();
    await db.update(processedPosts).set({ retryCount: 4 }).where(eq(processedPosts.id, post.id));

    await scheduleAt(post.id, new Date(Date.now() + MINUTE));

    expect((await reload(post.id)).retryCount).toBe(0);
  });
});
