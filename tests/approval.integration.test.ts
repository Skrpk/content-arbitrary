import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import { processedPosts, sources, syncState, telegramMessages } from '@/db/schema';
import { syncPosts } from '@/lib/sync/sync-posts';
import { XClient } from '@/lib/x/client';
import { TelegramClient } from '@/lib/telegram/client';
import {
  buildCallbackData,
  parseCallbackData,
  publishApprovedPayload,
} from '@/lib/sync/approval';
import {
  claimForDecision,
  findPostAwaitingReview,
  markAwaitingApproval,
  markPublished,
  rejectWithReason,
  updateApprovalCaption,
} from '@/lib/sync/repository';
import { DEFAULT_WORKSPACE_ID } from '@/db/schema';
import { createTestLogger, instantSleep, withEnv, ensureTestWorkspace, POSTED_AT } from './helpers';

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
        created_at: POSTED_AT,
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
  // Sources are global state too; a row left by another file would be synced
  // instead of the one this file expects.
  await db.delete(sources);
  await ensureTestWorkspace(db);
});

async function runSync(
  stack: ReturnType<typeof makeStack>,
  mediaKeys = ['3_1', '3_2'],
  payload: unknown = timelinePayload(mediaKeys),
) {
  return withEnv(approvalEnv, (env) =>
    syncPosts({
      db,
      env,
      xClient: makeXClient(payload),
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
      reviewedAt: new Date(),
      // Ignored: a reviewed post already has its captions.
      caption: 'not this',
    });

    // Publishing re-sends by file_id: exactly one call, straight to the channel,
    // with no media download at all.
    expect(stack.sends).toEqual([{ method: 'sendMediaGroup', chatId: CHANNEL_CHAT }]);

    const finalRow = (await db.select().from(processedPosts).where(eq(processedPosts.id, row.id)))[0];
    expect(finalRow?.status).toBe('published');
    expect(finalRow?.approvalPayload).toBeNull();
    expect(finalRow?.reviewedAt).toBeInstanceOf(Date);
    expect(finalRow?.caption).toBe(row.caption);
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

    await rejectWithReason(db, { id: row.id, workspaceId: DEFAULT_WORKSPACE_ID, reason: 'other' });

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

  it('previews a single-media post as media plus a control message', async () => {
    const stack = makeStack();
    await runSync(stack, ['3_1']);

    // The media carries the exact channel caption; the buttons and the source
    // line live on the message underneath.
    expect(stack.sends.map((send) => send.method)).toEqual(['sendPhoto', 'sendMessage']);

    const row = (await db.select().from(processedPosts))[0];
    expect(row?.adminMessageId).toBe(12);
    expect(row?.approvalPayload?.method).toBe('sendPhoto');
    // Only the media file_id is stored — the control message is not publishable.
    expect(row?.approvalPayload?.items).toHaveLength(1);
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

    // No review, so no review time — but the text that went out is on record.
    const row = (await db.select().from(processedPosts))[0]!;
    expect(row.reviewedAt).toBeNull();
    expect(row.originalCaption).toContain('Bear by the lake');
    expect(row.caption).toBe(row.originalCaption);
    expect(row.sourceText).toBe('Bear by the lake');
  });
});

describeIfDb('editing the caption before approval', () => {
  const edited = 'My own words, not the author\'s.';

  async function queueOne() {
    const stack = makeStack();
    await runSync(stack, ['3_1']);
    const row = (await db.select().from(processedPosts))[0]!;
    return { stack, row };
  }

  it('publishes the edited caption, not the original', async () => {
    const { row } = await queueOne();
    const original = row.approvalPayload!.caption;

    const result = await updateApprovalCaption(db, {
      id: row.id,
      workspaceId: DEFAULT_WORKSPACE_ID,
      caption: edited,
    });
    expect(result.updated).toBe(true);

    // Approve, and watch which caption actually goes out.
    const publishStack = makeStack();
    const captions: unknown[] = [];
    const claim = await claimForDecision(db, row.id, DEFAULT_WORKSPACE_ID);
    expect(claim.row!.approvalPayload!.caption).toBe(edited);
    expect(claim.row!.approvalPayload!.caption).not.toBe(original);

    await publishApprovedPayload(
      {
        client: publishStack.client,
        chatId: CHANNEL_CHAT,
        disableNotification: false,
      },
      claim.row!.approvalPayload!,
      { logger: createTestLogger(), sleep: instantSleep },
    );

    captions.push(...publishStack.sends.map((send) => send.method));
    expect(captions).toEqual(['sendPhoto']);
  });

  it('leaves the stored media untouched', async () => {
    const { row } = await queueOne();
    const fileIds = row.approvalPayload!.items.map((item) => item.fileId);

    await updateApprovalCaption(db, {
      id: row.id,
      workspaceId: DEFAULT_WORKSPACE_ID,
      caption: edited,
    });

    const after = await findPostAwaitingReview(db, {
      id: row.id,
      workspaceId: DEFAULT_WORKSPACE_ID,
    });

    // Only the text changes: the file_ids are what make approval cheap, and
    // re-deriving them would mean downloading from X again.
    expect(after!.approvalPayload!.items.map((item) => item.fileId)).toEqual(fileIds);
    expect(after!.approvalPayload!.method).toBe('sendPhoto');
    expect(after!.captionEditedAt).toBeInstanceOf(Date);
  });

  it('records the preview message so the chat can be refreshed', async () => {
    const { row } = await queueOne();
    // sendPhoto returned message_id 30; the control message is 12.
    expect(row.approvalPayload!.adminMediaMessageId).toBe(30);
    expect(row.adminMessageId).toBe(12);
  });

  it('drops the overflow follow-up, which the new text replaces', async () => {
    const { row } = await queueOne();

    await db
      .update(processedPosts)
      .set({
        approvalPayload: { ...row.approvalPayload!, overflowMessage: 'the full original text' },
      })
      .where(eq(processedPosts.id, row.id));

    await updateApprovalCaption(db, {
      id: row.id,
      workspaceId: DEFAULT_WORKSPACE_ID,
      caption: edited,
    });

    const after = await findPostAwaitingReview(db, {
      id: row.id,
      workspaceId: DEFAULT_WORKSPACE_ID,
    });
    expect(after!.approvalPayload!.overflowMessage).toBeUndefined();
  });

  it('refuses to edit a post that is already published', async () => {
    const { row } = await queueOne();

    await claimForDecision(db, row.id, DEFAULT_WORKSPACE_ID);
    await markPublished(db, {
      id: row.id,
      telegramChatId: CHANNEL_CHAT,
      primaryMessageId: 30,
      telegramMethod: 'sendPhoto',
      mediaCount: 1,
      messages: [],
    });

    const result = await updateApprovalCaption(db, {
      id: row.id,
      workspaceId: DEFAULT_WORKSPACE_ID,
      caption: edited,
    });

    expect(result).toEqual({ updated: false, currentStatus: 'published' });
  });

  it('refuses to edit a post that was rejected', async () => {
    const { row } = await queueOne();

    await rejectWithReason(db, { id: row.id, workspaceId: DEFAULT_WORKSPACE_ID, reason: 'other' });

    const result = await updateApprovalCaption(db, {
      id: row.id,
      workspaceId: DEFAULT_WORKSPACE_ID,
      caption: edited,
    });

    expect(result.updated).toBe(false);
    expect(result.currentStatus).toBe('rejected');
  });

  it('refuses an edit from another tenant', async () => {
    const { row } = await queueOne();

    const result = await updateApprovalCaption(db, {
      id: row.id,
      workspaceId: 999,
      caption: 'not yours',
    });

    expect(result.updated).toBe(false);

    const after = await findPostAwaitingReview(db, {
      id: row.id,
      workspaceId: DEFAULT_WORKSPACE_ID,
    });
    expect(after!.approvalPayload!.caption).not.toBe('not yours');
  });

  it('finds nothing for a post id that does not exist', async () => {
    expect(
      await findPostAwaitingReview(db, { id: 987654, workspaceId: DEFAULT_WORKSPACE_ID }),
    ).toBeNull();
  });
});

describeIfDb('original and current caption', () => {
  async function queueOne() {
    const stack = makeStack();
    await runSync(stack, ['3_1']);
    return (await db.select().from(processedPosts))[0]!;
  }

  async function reload(id: number) {
    return (await db.select().from(processedPosts).where(eq(processedPosts.id, id)))[0]!;
  }

  const edit = (id: number, caption: string) =>
    updateApprovalCaption(db, { id, workspaceId: DEFAULT_WORKSPACE_ID, caption });

  it('starts a new review item with both captions equal to what was sent', async () => {
    const row = await queueOne();

    expect(row.originalCaption).toContain('Bear by the lake');
    expect(row.originalCaption).toBe(row.approvalPayload!.caption);
    expect(row.caption).toBe(row.originalCaption);
    expect(row.captionEditedAt).toBeNull();
  });

  it('changes only the current caption on edit', async () => {
    const row = await queueOne();
    const original = row.originalCaption;

    await edit(row.id, 'B');
    const after = await reload(row.id);

    expect(after.originalCaption).toBe(original);
    expect(after.caption).toBe('B');
    expect(after.captionEditedAt).toBeInstanceOf(Date);
  });

  it('keeps the first original through any number of edits', async () => {
    const row = await queueOne();
    const original = row.originalCaption;

    await edit(row.id, 'B');
    const first = (await reload(row.id)).captionEditedAt!;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await edit(row.id, 'C');
    const after = await reload(row.id);

    expect(after.originalCaption).toBe(original);
    expect(after.caption).toBe('C');
    // The time of the latest save, not the first.
    expect(after.captionEditedAt!.getTime()).toBeGreaterThan(first.getTime());
  });

  it('keeps both captions after publishing drops the payload', async () => {
    const row = await queueOne();
    await edit(row.id, 'C');

    await claimForDecision(db, row.id, DEFAULT_WORKSPACE_ID);
    await markPublished(db, {
      id: row.id,
      telegramChatId: CHANNEL_CHAT,
      primaryMessageId: 30,
      telegramMethod: 'sendPhoto',
      mediaCount: 1,
      messages: [],
    });
    const after = await reload(row.id);

    expect(after.approvalPayload).toBeNull();
    expect(after.originalCaption).toBe(row.originalCaption);
    expect(after.caption).toBe('C');
  });

  it('keeps both captions after a rejection', async () => {
    const row = await queueOne();

    await rejectWithReason(db, { id: row.id, workspaceId: DEFAULT_WORKSPACE_ID, reason: 'too_minor' });
    const after = await reload(row.id);

    expect(after.approvalPayload).toBeNull();
    expect(after.originalCaption).toBe(row.originalCaption);
    expect(after.caption).toBe(row.originalCaption);
  });

  it('stores an empty caption for a media-only post as an empty string, not null', async () => {
    const row = await queueOne();
    // Reset to a fresh queue entry whose caption is empty, as for a post with
    // no text and the source link turned off.
    await db
      .update(processedPosts)
      .set({ status: 'processing', originalCaption: null, caption: null, approvalPayload: null })
      .where(eq(processedPosts.id, row.id));

    await markAwaitingApproval(db, {
      id: row.id,
      payload: { method: 'sendPhoto', caption: '', items: [{ kind: 'photo', fileId: 'ONE' }] },
      adminChatId: ADMIN_CHAT,
      adminMessageId: 12,
    });
    const after = await reload(row.id);

    expect(after.originalCaption).toBe('');
    expect(after.caption).toBe('');
  });

  it('never overwrites the original if a post is queued for review again', async () => {
    const row = await queueOne();
    await edit(row.id, 'B');

    await db.update(processedPosts).set({ status: 'processing' }).where(eq(processedPosts.id, row.id));
    await markAwaitingApproval(db, {
      id: row.id,
      payload: { ...row.approvalPayload!, caption: 'a fresh render' },
      adminChatId: ADMIN_CHAT,
      adminMessageId: 13,
    });
    const after = await reload(row.id);

    expect(after.originalCaption).toBe(row.originalCaption);
    expect(after.caption).toBe('B');
  });

  /**
   * A post queued by the previous deploy, after the migration ran but before
   * the new code went live, has a payload and no caption columns. Each way out
   * of review must still leave its text behind.
   */
  describe('a post queued before the caption columns existed', () => {
    async function queueLegacy(caption = 'A') {
      const row = await queueOne();
      await db
        .update(processedPosts)
        .set({
          originalCaption: null,
          caption: null,
          approvalPayload: { ...row.approvalPayload!, caption },
        })
        .where(eq(processedPosts.id, row.id));
      return row.id;
    }

    it('keeps the old text as the original when edited', async () => {
      const id = await queueLegacy('A');
      await edit(id, 'B');
      const after = await reload(id);

      expect(after.originalCaption).toBe('A');
      expect(after.caption).toBe('B');
    });

    it('keeps its text when published', async () => {
      const id = await queueLegacy('A');
      await claimForDecision(db, id, DEFAULT_WORKSPACE_ID);
      await markPublished(db, {
        id,
        telegramChatId: CHANNEL_CHAT,
        primaryMessageId: 30,
        telegramMethod: 'sendPhoto',
        mediaCount: 1,
        messages: [],
      });
      const after = await reload(id);

      expect(after.originalCaption).toBe('A');
      expect(after.caption).toBe('A');
    });

    it('keeps its text when rejected', async () => {
      const id = await queueLegacy('A');
      await rejectWithReason(db, { id, workspaceId: DEFAULT_WORKSPACE_ID, reason: 'other' });
      const after = await reload(id);

      expect(after.originalCaption).toBe('A');
      expect(after.caption).toBe('A');
    });
  });
});

describeIfDb('caption backfill migration', () => {
  /** Runs the real migration file, so the test cannot drift from what ships. */
  async function runBackfill() {
    const folder = path.join(process.cwd(), 'src/db/migrations');
    const file = readdirSync(folder).find((name) => name.endsWith('_backfill_review_captions.sql'));
    expect(file).toBeDefined();
    await sql.unsafe(readFileSync(path.join(folder, file!), 'utf8'));
  }

  async function insertLegacy(values: Partial<typeof processedPosts.$inferInsert>) {
    const rows = await db
      .insert(processedPosts)
      .values({
        xPostId: String(Math.floor(Math.random() * 1e12)),
        xPostUrl: 'https://x.com/a/status/1',
        status: 'awaiting_approval',
        ...values,
      })
      .returning();
    return rows[0]!.id;
  }

  const legacyPayload = (caption: string, extra?: Record<string, unknown>) =>
    ({ method: 'sendPhoto', caption, items: [{ kind: 'photo', fileId: 'F' }], ...extra }) as never;

  async function reload(id: number) {
    return (await db.select().from(processedPosts).where(eq(processedPosts.id, id)))[0]!;
  }

  it('gives an existing caption to both columns', async () => {
    const id = await insertLegacy({ approvalPayload: legacyPayload('A') });
    await runBackfill();
    const row = await reload(id);

    expect(row.originalCaption).toBe('A');
    expect(row.caption).toBe('A');
    expect(row.captionEditedAt).toBeNull();
  });

  it('carries an earlier edit time across, marking an original it could not recover', async () => {
    const id = await insertLegacy({
      approvalPayload: legacyPayload('Edited', { captionEditedAt: '2026-09-30T10:00:00.000Z' }),
    });
    await runBackfill();
    const row = await reload(id);

    expect(row.originalCaption).toBe('Edited');
    expect(row.caption).toBe('Edited');
    expect(row.captionEditedAt?.toISOString()).toBe('2026-09-30T10:00:00.000Z');
  });

  it('keeps an empty media-only caption as an empty string', async () => {
    const id = await insertLegacy({ approvalPayload: legacyPayload('') });
    await runBackfill();
    const row = await reload(id);

    expect(row.originalCaption).toBe('');
    expect(row.caption).toBe('');
  });

  it('leaves settled rows, whose payload is gone, untouched', async () => {
    const id = await insertLegacy({ status: 'published', approvalPayload: null });
    await runBackfill();
    const row = await reload(id);

    expect(row.originalCaption).toBeNull();
    expect(row.caption).toBeNull();
  });

  it('is safe to run twice and never overwrites a recorded original', async () => {
    const id = await insertLegacy({ approvalPayload: legacyPayload('A') });
    await runBackfill();
    await db
      .update(processedPosts)
      .set({ caption: 'B', approvalPayload: legacyPayload('B') })
      .where(eq(processedPosts.id, id));
    await runBackfill();
    const row = await reload(id);

    expect(row.originalCaption).toBe('A');
    expect(row.caption).toBe('B');
  });
});

describeIfDb('source text', () => {
  it('records and captions the whole text of a long-form post, not the 280-character cut', async () => {
    const full = `${'A long thought. '.repeat(30)}The end.`;
    const payload = timelinePayload(['3_1']) as ReturnType<typeof timelinePayload> & {
      data: Record<string, unknown>[];
    };
    payload.data[0]!.text = 'A long thought. A long thought…';
    payload.data[0]!.note_tweet = { text: full };

    await runSync(makeStack(), ['3_1'], payload);
    const row = (await db.select().from(processedPosts))[0]!;

    expect(row.sourceText).toBe(full.trim());
    expect(row.sourceText!.length).toBeGreaterThan(280);
    expect(row.caption).toContain(full.trim());
    expect(row.caption).not.toContain('A long thought…');
  });

  /**
   * A long-form post past the caption limit goes out as media with a
   * shortened caption, followed by the whole text as its own message.
   */
  it('publishes a long-form post past the caption limit as caption plus the full text', async () => {
    const full = `${'Sentence number something. '.repeat(60)}The very end.`;
    const payload = timelinePayload(['3_1']) as ReturnType<typeof timelinePayload> & {
      data: Record<string, unknown>[];
    };
    payload.data[0]!.text = 'Sentence number something…';
    payload.data[0]!.note_tweet = { text: full };

    const review = makeStack();
    await runSync(review, ['3_1'], payload);
    const row = (await db.select().from(processedPosts))[0]!;
    expect(row.caption!.length).toBeLessThanOrEqual(1024);
    expect(row.approvalPayload!.overflowMessage).toContain('The very end.');
    // The reviewer sees the follow-up too, before deciding.
    expect(review.sends).toEqual([
      { method: 'sendPhoto', chatId: ADMIN_CHAT },
      { method: 'sendMessage', chatId: ADMIN_CHAT },
      { method: 'sendMessage', chatId: ADMIN_CHAT },
    ]);
    expect(row.approvalPayload!.adminOverflowMessageId).toBeDefined();

    const channel = makeStack();
    const texts: string[] = [];
    const claim = await claimForDecision(db, row.id, DEFAULT_WORKSPACE_ID);
    await publishApprovedPayload(
      { client: channel.client, chatId: CHANNEL_CHAT, disableNotification: false },
      claim.row!.approvalPayload!,
      { logger: createTestLogger(), sleep: instantSleep },
    );
    for (const call of (channel.fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls) {
      const body = (call[1] as RequestInit | undefined)?.body;
      if (typeof body === 'string') texts.push(String((JSON.parse(body) as { text?: string }).text ?? ''));
    }

    expect(channel.sends.map((send) => send.method)).toEqual(['sendPhoto', 'sendMessage']);
    expect(texts.some((text) => text.includes('The very end.'))).toBe(true);
  });

  it('keeps the source text after the post is rejected', async () => {
    await runSync(makeStack(), ['3_1']);
    const row = (await db.select().from(processedPosts))[0]!;

    await rejectWithReason(db, { id: row.id, workspaceId: DEFAULT_WORKSPACE_ID, reason: 'weak_source' });
    const after = (await db.select().from(processedPosts).where(eq(processedPosts.id, row.id)))[0]!;

    expect(after.sourceText).toBe('Bear by the lake');
  });
});

describeIfDb('text-only posts', () => {
  const textPost = {
    data: [
      { id: '1750000000000000077', text: 'No pictures, just news &amp; views', author_id: '999' },
    ],
    includes: { users: [{ id: '999', username: 'Trail_Cams' }] },
    meta: { result_count: 1, newest_id: '1750000000000000077' },
  };

  async function watch(includeTextOnly: boolean) {
    await db.insert(sources).values({
      externalId: '999',
      username: 'Trail_Cams',
      includeTextOnly,
    });
  }

  it('are skipped for a source that mirrors media only, as before', async () => {
    await watch(false);
    const stack = makeStack();

    const summary = await runSync(stack, [], textPost);

    expect(summary.awaitingApproval).toBe(0);
    expect(stack.sends).toHaveLength(0);
    expect(await db.select().from(processedPosts)).toHaveLength(0);
  });

  it('go to review, then to the channel as text, for a source that mirrors them', async () => {
    await watch(true);
    const review = makeStack();

    const summary = await runSync(review, [], textPost);

    expect(summary.awaitingApproval).toBe(1);
    // The post itself, then the control message with the buttons.
    expect(review.sends).toEqual([
      { method: 'sendMessage', chatId: ADMIN_CHAT },
      { method: 'sendMessage', chatId: ADMIN_CHAT },
    ]);

    const row = (await db.select().from(processedPosts))[0]!;
    expect(row.status).toBe('awaiting_approval');
    expect(row.approvalPayload).toMatchObject({ method: 'sendMessage', items: [] });
    expect(row.mediaCount).toBe(0);
    expect(row.sourceText).toBe('No pictures, just news & views');
    expect(row.originalCaption).toContain('No pictures, just news &amp; views');

    const channel = makeStack();
    const claim = await claimForDecision(db, row.id, DEFAULT_WORKSPACE_ID);
    await publishApprovedPayload(
      { client: channel.client, chatId: CHANNEL_CHAT, disableNotification: false },
      claim.row!.approvalPayload!,
      { logger: createTestLogger(), sleep: instantSleep },
    );

    expect(channel.sends).toEqual([{ method: 'sendMessage', chatId: CHANNEL_CHAT }]);
  });

  it('are published straight to the channel when approval is off', async () => {
    await watch(true);
    const stack = makeStack();

    const summary = await withEnv({ ...approvalEnv, REQUIRE_APPROVAL: 'false' }, (env) =>
      syncPosts({
        db,
        env,
        xClient: makeXClient(textPost),
        telegramClient: stack.client,
        fetchImpl: stack.fetchImpl,
        logger: createTestLogger(),
        sleep: instantSleep,
        skipLock: true,
      }),
    );

    expect(summary.published).toBe(1);
    expect(stack.sends).toEqual([{ method: 'sendMessage', chatId: CHANNEL_CHAT }]);
    const row = (await db.select().from(processedPosts))[0]!;
    expect(row.status).toBe('published');
    expect(row.telegramMethod).toBe('sendMessage');
    expect(row.caption).toContain('No pictures');
  });
});
