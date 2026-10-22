import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import {
  DEFAULT_WORKSPACE_ID,
  processedPosts,
  reviewCopies,
  sources,
  syncState,
  telegramMessages,
  workspaceMembers,
  workspaces,
} from '@/db/schema';
import { addWorkspaceMember, removeWorkspaceMember } from '@/lib/accounts/users';
import { recordReviewCopies } from '@/lib/review/copies';
import { findWorkspacesByAdminChatId } from '@/lib/workspace';
import { POST as webhook } from '@/app/api/telegram/webhook/route';
import { ensureTestWorkspace, telegramOk, withEnv } from './helpers';

/**
 * A second reviewer of a channel, added and removed as a member, acts on its
 * posts through the bot exactly as the named reviewer does — and loses that the
 * moment the membership goes.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

const SECRET = 'a'.repeat(64);
const BOT_TOKEN = '123456:AAHfakeTokenForTestsOnly';
const NAMED_REVIEWER = 555001;
const ADDED_REVIEWER = 777003;
const CHANNEL = '-1001000000001';
const ADDED_CONTROL_MESSAGE = 22;

const routeEnv = {
  DATABASE_URL: connectionString,
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_CHAT_ID: CHANNEL,
  TELEGRAM_ADMIN_CHAT_ID: String(NAMED_REVIEWER),
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
      const method = String(input).split('/').pop()!;
      calls.push({
        method,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      if (method === 'sendPhoto') {
        return telegramOk({
          message_id: 900,
          chat: { id: -1 },
          photo: [{ file_id: 'X', file_size: 1 }],
        });
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
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': SECRET,
        },
        body: JSON.stringify({ update_id: 1, ...update }),
      }),
    ),
  );
}

/** A button press, from `fromId`, on the message it was pressed on. */
const press = (data: string, fromId: number) =>
  send({
    callback_query: {
      id: 'cb',
      from: { id: fromId },
      data,
      message: { message_id: 12, chat: { id: fromId } },
    },
  });

const answerOf = () => String(callsTo('answerCallbackQuery').at(-1)?.body.text ?? '');

async function queuedPost() {
  const rows = await db
    .insert(processedPosts)
    .values({
      workspaceId: DEFAULT_WORKSPACE_ID,
      externalId: String(1_750_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1e6))),
      xPostUrl: 'https://x.com/someone/status/1750000000000000001',
      xAuthorUsername: 'someone',
      status: 'awaiting_approval',
      adminChatId: String(NAMED_REVIEWER),
      adminMessageId: 12,
      approvalPayload: {
        method: 'sendPhoto',
        caption: 'Hi',
        items: [{ kind: 'photo', fileId: 'F' }],
      },
      originalCaption: 'Hi',
      caption: 'Hi',
    })
    .returning();
  return rows[0]!;
}

async function statusOf(id: number) {
  return (await db.select().from(processedPosts).where(eq(processedPosts.id, id)))[0]!.status;
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
  stubNetwork();
  await db.delete(telegramMessages);
  await db.delete(processedPosts);
  await db.delete(syncState);
  await db.delete(sources);
  await db.delete(workspaceMembers);
  await ensureTestWorkspace(db);
  await db
    .update(workspaces)
    .set({
      name: 'Alpha',
      telegramChatId: CHANNEL,
      telegramAdminChatId: String(NAMED_REVIEWER),
    })
    .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
});

describeIfDb('a reviewer added to a channel', () => {
  it('can act on its posts through the bot', async () => {
    await addWorkspaceMember(db, DEFAULT_WORKSPACE_ID, {
      id: ADDED_REVIEWER,
      name: 'Olena',
    });
    const post = await queuedPost();

    await press(`ap:${post.id}`, ADDED_REVIEWER);

    expect(answerOf()).not.toMatch(/not authorised/);
    expect(await statusOf(post.id)).toBe('published');
  });

  it('is found as a reviewer of the channel, next to the named one', async () => {
    await addWorkspaceMember(db, DEFAULT_WORKSPACE_ID, { id: ADDED_REVIEWER });

    const named = (await findWorkspacesByAdminChatId(db, NAMED_REVIEWER)).map((workspace) => workspace.id);
    const added = (await findWorkspacesByAdminChatId(db, ADDED_REVIEWER)).map((workspace) => workspace.id);
    expect(named).toEqual([DEFAULT_WORKSPACE_ID]);
    expect(added).toEqual([DEFAULT_WORKSPACE_ID]);
  });

  it('loses it the moment the membership is removed', async () => {
    await addWorkspaceMember(db, DEFAULT_WORKSPACE_ID, { id: ADDED_REVIEWER });
    expect(await removeWorkspaceMember(db, DEFAULT_WORKSPACE_ID, ADDED_REVIEWER)).toBe(true);
    const post = await queuedPost();

    await press(`ap:${post.id}`, ADDED_REVIEWER);

    expect(answerOf()).toMatch(/not authorised/);
    expect(await statusOf(post.id)).toBe('awaiting_approval');
    expect(await findWorkspacesByAdminChatId(db, ADDED_REVIEWER)).toEqual([]);
  });

  it("keeps the named reviewer's access when another reviewer is removed", async () => {
    await addWorkspaceMember(db, DEFAULT_WORKSPACE_ID, { id: ADDED_REVIEWER });
    await removeWorkspaceMember(db, DEFAULT_WORKSPACE_ID, ADDED_REVIEWER);
    const post = await queuedPost();

    await press(`ap:${post.id}`, NAMED_REVIEWER);

    expect(answerOf()).not.toMatch(/not authorised/);
    expect(await statusOf(post.id)).toBe('published');
  });

  it('has their copy of a review settled when the post is decided', async () => {
    await addWorkspaceMember(db, DEFAULT_WORKSPACE_ID, { id: ADDED_REVIEWER });
    const post = await queuedPost();
    await recordReviewCopies(db, post.id, [
      {
        chatId: String(ADDED_REVIEWER),
        controlMessageId: ADDED_CONTROL_MESSAGE,
      },
    ]);

    await press(`ap:${post.id}`, NAMED_REVIEWER);

    const settled = callsTo('editMessageText').filter((call) => call.body.chat_id === String(ADDED_REVIEWER));
    expect(settled).toHaveLength(1);
    expect(settled[0]!.body.message_id).toBe(ADDED_CONTROL_MESSAGE);
    expect(String(settled[0]!.body.text)).toMatch(/Published/);
    expect(await db.select().from(reviewCopies).where(eq(reviewCopies.processedPostId, post.id))).toHaveLength(1);
  });

  it('is one row per reviewer, so adding twice changes nothing', async () => {
    await addWorkspaceMember(db, DEFAULT_WORKSPACE_ID, { id: ADDED_REVIEWER });
    await addWorkspaceMember(db, DEFAULT_WORKSPACE_ID, { id: ADDED_REVIEWER });

    const rows = await db
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, DEFAULT_WORKSPACE_ID)));
    expect(rows).toHaveLength(1);
  });
});
