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
import { POST } from '@/app/api/telegram/webhook/route';
import { updateApprovalCaption } from '@/lib/sync/repository';
import { ensureTestWorkspace, telegramError, telegramOk, withEnv } from './helpers';

/**
 * The review buttons end to end: a Telegram update goes through the webhook
 * route itself, against a real database, with only the Bot API stubbed out.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

const SECRET = 'a'.repeat(64);
const REVIEWER_ID = 555001;
const STRANGER_ID = 424242;
const OTHER_WORKSPACE = 2;
const OTHER_REVIEWER_ID = 777002;
const CHANNEL_CHAT = '-1001000000001';
const CONTROL_MESSAGE_ID = 12;

const routeEnv = {
  DATABASE_URL: connectionString,
  TELEGRAM_CHAT_ID: CHANNEL_CHAT,
  TELEGRAM_ADMIN_CHAT_ID: String(REVIEWER_ID),
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  REQUIRE_APPROVAL: 'true',
  APP_BASE_URL: 'https://example.vercel.app',
};

/** Every Bot API call the route makes, by method, with its JSON body. */
let calls: { method: string; body: Record<string, unknown> }[];
/** Lets a test make one method fail. */
let failMethod: { method: string; description: string } | null;

function stubTelegram() {
  calls = [];
  failMethod = null;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const method = String(input).split('/').pop()!;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ method, body });

      if (failMethod?.method === method) return telegramError(400, failMethod.description);
      if (method === 'sendPhoto') {
        return telegramOk({ message_id: 900, chat: { id: -1 }, photo: [{ file_id: 'ONE', file_size: 1 }] });
      }
      if (method === 'sendMessage') return telegramOk({ message_id: 901, chat: { id: -1 } });
      return telegramOk(true);
    }),
  );
}

const callsTo = (method: string) => calls.filter((call) => call.method === method);

function press(data: string, fromId = REVIEWER_ID, env: Record<string, string | undefined> = {}) {
  return withEnv({ ...routeEnv, ...env }, () =>
    POST(
      new Request('https://example.vercel.app/api/telegram/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': SECRET,
        },
        body: JSON.stringify({
          update_id: 1,
          callback_query: {
            id: 'cb-1',
            from: { id: fromId },
            data,
            message: { message_id: CONTROL_MESSAGE_ID, chat: { id: fromId } },
          },
        }),
      }),
    ),
  );
}

function send(text: string, env: Record<string, string | undefined> = {}) {
  return withEnv({ ...routeEnv, ...env }, () =>
    POST(
      new Request('https://example.vercel.app/api/telegram/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': SECRET,
        },
        body: JSON.stringify({
          update_id: 2,
          message: {
            message_id: 5,
            from: { id: REVIEWER_ID },
            chat: { id: REVIEWER_ID, type: 'private' },
            text,
          },
        }),
      }),
    ),
  );
}

async function queuePost(options?: { caption?: string; workspaceId?: number; textOnly?: boolean }) {
  const caption = options?.caption ?? 'A';
  const rows = await db
    .insert(processedPosts)
    .values({
      workspaceId: options?.workspaceId ?? DEFAULT_WORKSPACE_ID,
      xPostId: String(1_750_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1e6))),
      xPostUrl: 'https://x.com/someone/status/1750000000000000001',
      xAuthorUsername: 'someone',
      status: 'awaiting_approval',
      adminChatId: String(REVIEWER_ID),
      adminMessageId: CONTROL_MESSAGE_ID,
      approvalPayload: options?.textOnly
        ? { method: 'sendMessage', caption, items: [] }
        : { method: 'sendPhoto', caption, items: [{ kind: 'photo', fileId: 'FILE_A' }] },
      originalCaption: caption,
      caption,
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
  // The route opened its own pool through getDb().
  await (globalThis as { __contentArbitrarySql?: postgres.Sql }).__contentArbitrarySql?.end();
});

beforeEach(async () => {
  if (!connectionString) return;
  stubTelegram();
  await db.delete(telegramMessages);
  await db.delete(processedPosts);
  await db.delete(syncState);
  await db.delete(sources);
  await ensureTestWorkspace(db);
  await db
    .update(workspaces)
    .set({ telegramChatId: CHANNEL_CHAT, telegramAdminChatId: String(REVIEWER_ID) })
    .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describeIfDb('Reject', () => {
  it('shows the reasons instead of rejecting', async () => {
    const post = await queuePost();

    const response = await press(`rj:${post.id}`);
    expect(response.status).toBe(200);

    const [swap] = callsTo('editMessageReplyMarkup');
    expect(swap?.body.message_id).toBe(CONTROL_MESSAGE_ID);
    const data = (
      swap?.body.reply_markup as { inline_keyboard: { callback_data?: string }[][] }
    ).inline_keyboard
      .flat()
      .map((button) => button.callback_data);
    expect(data).toContain(`rr:${post.id}:already_covered`);
    expect(data).toContain(`rb:${post.id}`);
    // With a Mini App configured, Other opens it so the reviewer can say why.
    const other = (
      swap?.body.reply_markup as { inline_keyboard: { text: string; web_app?: { url: string } }[][] }
    ).inline_keyboard
      .flat()
      .find((button) => button.text === '••• Other');
    expect(other?.web_app?.url).toBe(`https://example.vercel.app/review/reject?post=${post.id}`);

    // Nothing is decided yet: the post is still in the queue, still approvable.
    const after = await reload(post.id);
    expect(after.status).toBe('awaiting_approval');
    expect(after.rejectionReason).toBeNull();
    expect(after.reviewedAt).toBeNull();
    expect(after.approvalPayload).not.toBeNull();
    expect(callsTo('sendPhoto')).toHaveLength(0);
  });

  it('treats a repeated Reject tap, which Telegram calls "not modified", as fine', async () => {
    const post = await queuePost();
    failMethod = {
      method: 'editMessageReplyMarkup',
      description: 'Bad Request: message is not modified',
    };

    await press(`rj:${post.id}`);

    const [answer] = callsTo('answerCallbackQuery');
    expect(answer?.body.text).toBe('Why does it not fit?');
    expect((await reload(post.id)).status).toBe('awaiting_approval');
  });

  it('records the chosen reason and settles the post', async () => {
    const post = await queuePost();

    await press(`rj:${post.id}`);
    await press(`rr:${post.id}:already_covered`);

    const after = await reload(post.id);
    expect(after.status).toBe('rejected');
    expect(after.rejectionReason).toBe('already_covered');
    expect(after.rejectionNote).toBeNull();
    expect(after.reviewedAt).toBeInstanceOf(Date);
    expect(callsTo('sendPhoto')).toHaveLength(0);

    // The reviewer sees what was recorded, and the buttons are gone.
    const [note] = callsTo('editMessageText');
    expect(note?.body.text).toContain('Rejected');
    expect(note?.body.text).toContain('Already covered');
    expect(note?.body.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it('brings the original buttons back on Back, deciding nothing', async () => {
    const post = await queuePost();

    await press(`rj:${post.id}`);
    await press(`rb:${post.id}`);

    const restored = callsTo('editMessageReplyMarkup').at(-1)!;
    expect(restored.body.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: `ap:${post.id}` },
          { text: '🚫 Reject', callback_data: `rj:${post.id}` },
        ],
        [{ text: '✏️ Edit text', web_app: { url: `https://example.vercel.app/review?post=${post.id}` } }],
      ],
    });
    expect((await reload(post.id)).status).toBe('awaiting_approval');
  });

  it('ignores an unknown reason and leaves the post alone', async () => {
    const post = await queuePost();

    await press(`rr:${post.id}:bogus`);

    const after = await reload(post.id);
    expect(after.status).toBe('awaiting_approval');
    expect(after.rejectionReason).toBeNull();
    expect(callsTo('answerCallbackQuery')[0]?.body.text).toBe('Unrecognised action.');
  });

  it('keeps the first reason when a reason is pressed twice', async () => {
    const post = await queuePost();

    await press(`rr:${post.id}:already_covered`);
    await press(`rr:${post.id}:not_interesting`);

    const after = await reload(post.id);
    expect(after.rejectionReason).toBe('already_covered');
    expect(callsTo('answerCallbackQuery').at(-1)?.body.text).toBe('Already rejected.');
  });

  it('records no reason on a post that was already approved', async () => {
    const post = await queuePost();

    await press(`ap:${post.id}`);
    expect((await reload(post.id)).status).toBe('published');

    // A reason from a stale keyboard arrives after the post went out.
    await press(`rr:${post.id}:wrong_topic`);

    const after = await reload(post.id);
    expect(after.status).toBe('published');
    expect(after.rejectionReason).toBeNull();
    expect(callsTo('answerCallbackQuery').at(-1)?.body.text).toBe('Already published.');
  });

  it('does not reopen the reason list on a settled post', async () => {
    const post = await queuePost();
    await press(`rr:${post.id}:other`);
    const swapsBefore = callsTo('editMessageReplyMarkup').length;

    await press(`rj:${post.id}`);

    expect(callsTo('editMessageReplyMarkup')).toHaveLength(swapsBefore);
    expect(callsTo('answerCallbackQuery').at(-1)?.body.text).toBe('Already rejected.');
  });

  it('lets a stranger neither open the reasons nor reject', async () => {
    const post = await queuePost();

    await press(`rj:${post.id}`, STRANGER_ID);
    await press(`rr:${post.id}:other`, STRANGER_ID);

    const after = await reload(post.id);
    expect(after.status).toBe('awaiting_approval');
    expect(after.rejectionReason).toBeNull();
    expect(callsTo('editMessageReplyMarkup')).toHaveLength(0);
  });

  it('lets another tenant\'s reviewer neither open the reasons nor reject', async () => {
    await db.insert(workspaces).values({
      id: OTHER_WORKSPACE,
      name: 'second',
      telegramChatId: '-1002000000002',
      telegramAdminChatId: String(OTHER_REVIEWER_ID),
    });
    const post = await queuePost();

    await press(`rj:${post.id}`, OTHER_REVIEWER_ID);
    await press(`rr:${post.id}:other`, OTHER_REVIEWER_ID);

    const after = await reload(post.id);
    expect(after.status).toBe('awaiting_approval');
    expect(after.rejectionReason).toBeNull();
    expect(callsTo('editMessageReplyMarkup')).toHaveLength(0);
    // Indistinguishable from a post that does not exist.
    expect(callsTo('answerCallbackQuery').at(-1)?.body.text).toBe(
      'Not awaiting review (status: unknown).',
    );
  });
});

describeIfDb('Other without a Mini App', () => {
  it('is a plain button that rejects with no note', async () => {
    const post = await queuePost();

    await press(`rj:${post.id}`, REVIEWER_ID, { APP_BASE_URL: undefined });
    const buttons = (
      callsTo('editMessageReplyMarkup')[0]?.body.reply_markup as {
        inline_keyboard: { text: string; callback_data?: string }[][];
      }
    ).inline_keyboard.flat();
    expect(buttons.find((button) => button.text === '••• Other')?.callback_data).toBe(
      `rr:${post.id}:other`,
    );

    await press(`rr:${post.id}:other`);
    const after = await reload(post.id);
    expect(after.rejectionReason).toBe('other');
    expect(after.rejectionNote).toBeNull();
  });
});

describeIfDb('Approve', () => {
  const publishedCaption = () => callsTo('sendPhoto')[0]?.body.caption;

  it('publishes the caption as first sent when nobody edited it', async () => {
    const post = await queuePost({ caption: 'A' });

    await press(`ap:${post.id}`);

    expect(callsTo('sendPhoto')[0]?.body.chat_id).toBe(CHANNEL_CHAT);
    expect(publishedCaption()).toBe('A');
    const after = await reload(post.id);
    expect(after.reviewedAt).toBeInstanceOf(Date);
    expect(after.originalCaption).toBe('A');
    expect(after.caption).toBe('A');
  });

  it('publishes the latest edit and keeps the original on record', async () => {
    const post = await queuePost({ caption: 'A' });
    await updateApprovalCaption(db, { id: post.id, workspaceId: DEFAULT_WORKSPACE_ID, caption: 'B' });
    await updateApprovalCaption(db, { id: post.id, workspaceId: DEFAULT_WORKSPACE_ID, caption: 'C' });

    await press(`ap:${post.id}`);

    expect(publishedCaption()).toBe('C');
    const after = await reload(post.id);
    expect(after.status).toBe('published');
    expect(after.originalCaption).toBe('A');
    expect(after.caption).toBe('C');
  });

  it('publishes the column, not a payload copy that disagrees with it', async () => {
    const post = await queuePost({ caption: 'A' });
    await db.update(processedPosts).set({ caption: 'C' }).where(eq(processedPosts.id, post.id));

    await press(`ap:${post.id}`);

    expect(publishedCaption()).toBe('C');
  });

  it('still publishes a post queued before the caption column existed', async () => {
    const post = await queuePost({ caption: 'Legacy' });
    await db
      .update(processedPosts)
      .set({ originalCaption: null, caption: null })
      .where(eq(processedPosts.id, post.id));

    await press(`ap:${post.id}`);

    expect(publishedCaption()).toBe('Legacy');
    const after = await reload(post.id);
    expect(after.originalCaption).toBe('Legacy');
    expect(after.caption).toBe('Legacy');
  });

  it('publishes a post whose reason list was opened and then backed out of', async () => {
    const post = await queuePost();

    await press(`rj:${post.id}`);
    await press(`rb:${post.id}`);
    await press(`ap:${post.id}`);

    const after = await reload(post.id);
    expect(after.status).toBe('published');
    expect(after.rejectionReason).toBeNull();
  });

  it('publishes a text-only post as a text message', async () => {
    const post = await queuePost({ caption: 'Just words', textOnly: true });

    await press(`ap:${post.id}`);

    const [sent] = callsTo('sendMessage');
    expect(sent?.body.chat_id).toBe(CHANNEL_CHAT);
    expect(sent?.body.text).toBe('Just words');
    expect(callsTo('sendPhoto')).toHaveLength(0);

    const after = await reload(post.id);
    expect(after.status).toBe('published');
    expect(after.reviewedAt).toBeInstanceOf(Date);
  });

  it('lets a stranger not approve', async () => {
    const post = await queuePost();

    await press(`ap:${post.id}`, STRANGER_ID);

    expect((await reload(post.id)).status).toBe('awaiting_approval');
    expect(callsTo('sendPhoto')).toHaveLength(0);
  });
});

describeIfDb('the Settings button on source commands', () => {
  const markupOf = () => callsTo('sendMessage').at(-1)?.body.reply_markup;

  it('comes with the source list when the Mini App is configured', async () => {
    await db.insert(sources).values({ externalId: '999', username: 'someone' });

    await send('/sources');

    expect(markupOf()).toEqual({
      inline_keyboard: [[{ text: '⚙️ Settings', web_app: { url: 'https://example.vercel.app/settings' } }]],
    });
  });

  it('is left out without a Mini App', async () => {
    await db.insert(sources).values({ externalId: '999', username: 'someone' });

    await send('/sources', { APP_BASE_URL: undefined });

    expect(callsTo('sendMessage')).toHaveLength(1);
    expect(markupOf()).toBeUndefined();
  });

  it('is left out of an answer that is only a usage hint', async () => {
    await send('/addsource');

    expect(callsTo('sendMessage')).toHaveLength(1);
    expect(markupOf()).toBeUndefined();
  });
});
