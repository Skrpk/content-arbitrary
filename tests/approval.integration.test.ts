import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import { processedPosts, syncState, telegramMessages } from '@/db/schema';
import { syncPosts } from '@/lib/sync/sync-posts';
import { XClient } from '@/lib/x/client';
import { TelegramClient } from '@/lib/telegram/client';
import {
  buildCallbackData,
  parseCallbackData,
  publishApprovedPayload,
} from '@/lib/sync/approval';
import { claimForDecision, markPublished, markRejected } from '@/lib/sync/repository';
import { createTestLogger, instantSleep, withEnv } from './helpers';

/**
 * The whole review journey against a real database: a sync run parks a post in
 * the reviewer's queue, a simulated button press publishes it to the channel,
 * and a second press is refused.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

const ADMIN_CHAT = '555001';
const CHANNEL_CHAT = '-1003906212630';

const approvalEnv = {
  DRY_RUN: 'false',
  REQUIRE_APPROVAL: 'true',
  TELEGRAM_ADMIN_CHAT_ID: ADMIN_CHAT,
  TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(64),
  TELEGRAM_CHAT_ID: CHANNEL_CHAT,
};

function timelinePayload(mediaKeys: string[]) {
  return {
    data: [
      {
        id: '1750000000000000042',
        text: 'Bear by the lake',
        created_at: '2026-01-15T12:00:00.000Z',
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
    meta: { result_count: 1, newest_id: '1750000000000000042' },
  };
}

function makeXClient(payload: unknown) {
  return new XClient({
    bearerToken: 'fake',
    baseUrl: 'https://api.x.example',
    fetchImpl: vi.fn(async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch,
    attempts: 1,
  });
}

/** Telegram + CDN stub that records which chat each send went to. */
function makeStack() {
  const sends: { method: string; chatId: unknown }[] = [];

  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);

    if (!url.includes('api.telegram.example')) {
      return new Response(new Uint8Array(256), {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': '256' },
      });
    }

    const method = url.split('/').pop()!;
    const raw = init?.body;
    const body = (
      typeof raw === 'string' ? JSON.parse(raw) : Object.fromEntries((raw as FormData).entries())
    ) as Record<string, unknown>;
    sends.push({ method, chatId: body.chat_id });

    const ok = (result: unknown) =>
      new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    if (method === 'sendMediaGroup') {
      return ok([
        { message_id: 10, chat: { id: 555001 }, photo: [{ file_id: 'FILE_A', file_size: 900 }] },
        { message_id: 11, chat: { id: 555001 }, photo: [{ file_id: 'FILE_B', file_size: 900 }] },
      ]);
    }
    if (method === 'sendPhoto') {
      return ok({ message_id: 30, chat: { id: 555001 }, photo: [{ file_id: 'ONE', file_size: 900 }] });
    }
    return ok({ message_id: 12, chat: { id: 555001 } });
  });

  const client = new TelegramClient({
    token: '123456:TEST',
    baseUrl: 'https://api.telegram.example',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    attempts: 2,
    sleep: instantSleep,
  });

  return { client, fetchImpl: fetchImpl as unknown as typeof fetch, sends };
}

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
});

async function runSync(stack: ReturnType<typeof makeStack>, mediaKeys = ['3_1', '3_2']) {
  return withEnv(approvalEnv, (env) =>
    syncPosts({
      db,
      env,
      xClient: makeXClient(timelinePayload(mediaKeys)),
      telegramClient: stack.client,
      fetchImpl: stack.fetchImpl,
      logger: createTestLogger(),
      sleep: instantSleep,
      skipLock: true,
    }),
  );
}

describeIfDb('approval journey', () => {
  it('sends a new post to the reviewer instead of the channel', async () => {
    const stack = makeStack();
    const summary = await runSync(stack);

    expect(summary.awaitingApproval).toBe(1);
    expect(summary.published).toBe(0);

    // Every send went to the reviewer; the channel saw nothing.
    expect(stack.sends.every((send) => send.chatId === ADMIN_CHAT)).toBe(true);
    expect(stack.sends.some((send) => send.chatId === CHANNEL_CHAT)).toBe(false);

    const row = (await db.select().from(processedPosts))[0];
    expect(row?.status).toBe('awaiting_approval');
    expect(row?.approvalPayload?.items.map((item) => item.fileId)).toEqual(['FILE_A', 'FILE_B']);
    expect(row?.adminChatId).toBe(ADMIN_CHAT);
  });

  it('publishes to the channel when the Approve button is pressed', async () => {
    const stack = makeStack();
    await runSync(stack);

    const row = (await db.select().from(processedPosts))[0]!;
    const parsed = parseCallbackData(buildCallbackData('approve', row.id))!;

    stack.sends.length = 0;
    const claim = await claimForDecision(db, parsed.postId);
    expect(claim.claimed).toBe(true);

    const result = await publishApprovedPayload(
      { client: stack.client, chatId: CHANNEL_CHAT, disableNotification: false },
      claim.row!.approvalPayload!,
      { logger: createTestLogger(), sleep: instantSleep },
    );

    await markPublished(db, {
      id: parsed.postId,
      telegramChatId: CHANNEL_CHAT,
      primaryMessageId: result.primaryMessageId,
      telegramMethod: result.method,
      mediaCount: claim.row!.approvalPayload!.items.length,
      messages: result.messages,
    });

    // Publishing re-sends by file_id: exactly one call, straight to the channel,
    // with no media download at all.
    expect(stack.sends).toEqual([{ method: 'sendMediaGroup', chatId: CHANNEL_CHAT }]);

    const finalRow = (await db.select().from(processedPosts).where(eq(processedPosts.id, row.id)))[0];
    expect(finalRow?.status).toBe('published');
    expect(finalRow?.approvalPayload).toBeNull();
    expect(await db.select().from(telegramMessages)).toHaveLength(2);
  });

  it('refuses a second press after publishing', async () => {
    const stack = makeStack();
    await runSync(stack);

    const row = (await db.select().from(processedPosts))[0]!;
    await claimForDecision(db, row.id);
    await markPublished(db, {
      id: row.id,
      telegramChatId: CHANNEL_CHAT,
      primaryMessageId: 10,
      telegramMethod: 'sendMediaGroup',
      mediaCount: 2,
      messages: [],
    });

    const second = await claimForDecision(db, row.id);
    expect(second.claimed).toBe(false);
    expect(second.currentStatus).toBe('published');
  });

  it('never reaches the channel when rejected', async () => {
    const stack = makeStack();
    await runSync(stack);

    const row = (await db.select().from(processedPosts))[0]!;
    stack.sends.length = 0;

    await claimForDecision(db, row.id);
    await markRejected(db, row.id);

    expect(stack.sends).toHaveLength(0);

    const finalRow = (await db.select().from(processedPosts).where(eq(processedPosts.id, row.id)))[0];
    expect(finalRow?.status).toBe('rejected');
  });

  it('does not offer the same post for review twice', async () => {
    const first = makeStack();
    await runSync(first);

    const second = makeStack();
    const summary = await runSync(second);

    expect(summary.awaitingApproval).toBe(0);
    expect(second.sends).toHaveLength(0);
    expect(await db.select().from(processedPosts)).toHaveLength(1);
  });

  it('attaches the buttons to the photo itself for a single-media post', async () => {
    const stack = makeStack();
    await runSync(stack, ['3_1']);

    expect(stack.sends.map((send) => send.method)).toEqual(['sendPhoto']);

    const row = (await db.select().from(processedPosts))[0];
    expect(row?.adminMessageId).toBe(30);
    expect(row?.approvalPayload?.method).toBe('sendPhoto');
  });

  it('publishes straight to the channel when approval is off', async () => {
    const stack = makeStack();

    const summary = await withEnv(
      { ...approvalEnv, REQUIRE_APPROVAL: 'false' },
      (env) =>
        syncPosts({
          db,
          env,
          xClient: makeXClient(timelinePayload(['3_1', '3_2'])),
          telegramClient: stack.client,
          fetchImpl: stack.fetchImpl,
          logger: createTestLogger(),
          sleep: instantSleep,
          skipLock: true,
        }),
    );

    expect(summary.published).toBe(1);
    expect(summary.awaitingApproval).toBe(0);
    expect(stack.sends.every((send) => send.chatId === CHANNEL_CHAT)).toBe(true);
  });
});
