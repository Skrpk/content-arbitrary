import { createHmac } from 'node:crypto';
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
import { GET, POST } from '@/app/api/telegram/webapp/caption/route';
import { TELEGRAM_CAPTION_LIMIT } from '@/lib/telegram/limits';
import { withEnv, ensureTestWorkspace, telegramOk } from './helpers';

/**
 * The Mini App endpoint end to end: a signed request, a tenant lookup and a
 * guarded write, exercised through the route handlers themselves rather than
 * their parts.
 *
 * Posts here deliberately carry no `adminMediaMessageId`, so the best-effort
 * refresh of the reviewer's preview is skipped and no test touches the network.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

const BOT_TOKEN = '123456:AAHfakeTokenForTestsOnly';
const REVIEWER_ID = 555001;
const STRANGER_ID = 424242;
const OTHER_WORKSPACE = 2;

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
function initDataFor(userId: number, options?: { authDate?: number }): string {
  const fields: Record<string, string> = {
    auth_date: String(options?.authDate ?? Math.floor(Date.now() / 1000)),
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

function getRequest(postId: number | string, auth?: string) {
  return new Request(`https://example.vercel.app/api/telegram/webapp/caption?post=${postId}`, {
    headers: auth ? { authorization: auth } : {},
  });
}

function postRequest(body: unknown, auth?: string) {
  return new Request('https://example.vercel.app/api/telegram/webapp/caption', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  });
}

const payload = (caption: string): ApprovalPayload => ({
  method: 'sendPhoto',
  caption,
  items: [{ kind: 'photo', fileId: 'FILE_A' }],
});

async function insertAwaitingPost(options?: {
  caption?: string;
  workspaceId?: number;
  overflowMessage?: string;
}) {
  const rows = await db
    .insert(processedPosts)
    .values({
      workspaceId: options?.workspaceId ?? DEFAULT_WORKSPACE_ID,
      xPostId: `17500000000000${Math.floor(Math.random() * 90000) + 10000}`,
      xPostUrl: 'https://x.com/someone/status/1750000000000000001',
      xAuthorUsername: 'someone',
      status: 'awaiting_approval',
      adminChatId: String(REVIEWER_ID),
      adminMessageId: 12,
      approvalPayload: {
        ...payload(options?.caption ?? 'Original caption'),
        ...(options?.overflowMessage ? { overflowMessage: options.overflowMessage } : {}),
      },
    })
    .returning();

  return rows[0]!;
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
  await db.delete(sources);
  await ensureTestWorkspace(db);

  await db
    .update(workspaces)
    .set({ telegramChatId: '-1001000000001', telegramAdminChatId: String(REVIEWER_ID) })
    .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
});

describeIfDb('GET /api/telegram/webapp/caption', () => {
  it('returns the caption as plain text for the reviewer', async () => {
    const post = await insertAwaitingPost({ caption: 'Bear &amp; cub &lt;3' });

    const response = await withEnv(routeEnv, () =>
      GET(getRequest(post.id, `tma ${initDataFor(REVIEWER_ID)}`)),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { caption: string; limit: number };
    // Stored escaped, shown plain — the editor works in what the reviewer sees.
    expect(body.caption).toBe('Bear & cub <3');
    expect(body.limit).toBe(TELEGRAM_CAPTION_LIMIT);
  });

  it('refuses a request with no authorization at all', async () => {
    const post = await insertAwaitingPost();
    const response = await withEnv(routeEnv, () => GET(getRequest(post.id)));

    expect(response.status).toBe(401);
  });

  it('refuses tampered init data', async () => {
    const post = await insertAwaitingPost();
    const params = new URLSearchParams(initDataFor(REVIEWER_ID));
    params.set('user', JSON.stringify({ id: STRANGER_ID }));

    const response = await withEnv(routeEnv, () =>
      GET(getRequest(post.id, `tma ${params.toString()}`)),
    );

    expect(response.status).toBe(401);
  });

  it('refuses a validly signed user who reviews for nobody', async () => {
    const post = await insertAwaitingPost();

    const response = await withEnv(routeEnv, () =>
      GET(getRequest(post.id, `tma ${initDataFor(STRANGER_ID)}`)),
    );

    expect(response.status).toBe(401);
  });

  /**
   * The post id is not a credential: another tenant's post is indistinguishable
   * from one that does not exist.
   */
  it('hides another tenant\'s post behind the same 404', async () => {
    await db.insert(workspaces).values({
      id: OTHER_WORKSPACE,
      name: 'second',
      telegramChatId: '-1002000000002',
      telegramAdminChatId: '777002',
    });
    const theirs = await insertAwaitingPost({ workspaceId: OTHER_WORKSPACE });

    const response = await withEnv(routeEnv, () =>
      GET(getRequest(theirs.id, `tma ${initDataFor(REVIEWER_ID)}`)),
    );
    const missing = await withEnv(routeEnv, () =>
      GET(getRequest(987654, `tma ${initDataFor(REVIEWER_ID)}`)),
    );

    expect(response.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await response.json()).toEqual(await missing.json());
  });

  it('rejects a post id that is not a positive integer', async () => {
    const response = await withEnv(routeEnv, () =>
      GET(getRequest('abc', `tma ${initDataFor(REVIEWER_ID)}`)),
    );
    expect(response.status).toBe(400);
  });
});

describeIfDb('POST /api/telegram/webapp/caption', () => {
  it('saves the edited caption, escaped', async () => {
    const post = await insertAwaitingPost();

    const response = await withEnv(routeEnv, () =>
      POST(
        postRequest(
          { postId: post.id, caption: 'Rewritten <b>by hand</b> & proud' },
          `tma ${initDataFor(REVIEWER_ID)}`,
        ),
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; previewUpdated: boolean };
    expect(body.ok).toBe(true);
    // No adminMediaMessageId on this fixture, so no chat refresh was attempted.
    expect(body.previewUpdated).toBe(false);

    const row = (await db.select().from(processedPosts).where(eq(processedPosts.id, post.id)))[0]!;
    // Markup the reviewer typed is escaped, never passed through as HTML.
    expect(row.approvalPayload!.caption).toBe(
      'Rewritten &lt;b&gt;by hand&lt;/b&gt; &amp; proud',
    );
    expect(row.caption).toBe(row.approvalPayload!.caption);
    expect(row.captionEditedAt).toBeInstanceOf(Date);
  });

  it('round-trips what it saved', async () => {
    const post = await insertAwaitingPost();
    const text = 'Ведмідь <дуже> великий & вологий 🐻';

    await withEnv(routeEnv, () =>
      POST(postRequest({ postId: post.id, caption: text }, `tma ${initDataFor(REVIEWER_ID)}`)),
    );

    const response = await withEnv(routeEnv, () =>
      GET(getRequest(post.id, `tma ${initDataFor(REVIEWER_ID)}`)),
    );

    expect(((await response.json()) as { caption: string }).caption).toBe(text);
  });

  it('keeps the media and the method untouched', async () => {
    const post = await insertAwaitingPost();

    await withEnv(routeEnv, () =>
      POST(postRequest({ postId: post.id, caption: 'new words' }, `tma ${initDataFor(REVIEWER_ID)}`)),
    );

    const row = (await db.select().from(processedPosts).where(eq(processedPosts.id, post.id)))[0]!;
    expect(row.approvalPayload!.items).toEqual([{ kind: 'photo', fileId: 'FILE_A' }]);
    expect(row.approvalPayload!.method).toBe('sendPhoto');
    expect(row.status).toBe('awaiting_approval');
  });

  it('drops the overflow follow-up', async () => {
    const post = await insertAwaitingPost({ overflowMessage: 'the untruncated original' });

    await withEnv(routeEnv, () =>
      POST(postRequest({ postId: post.id, caption: 'short now' }, `tma ${initDataFor(REVIEWER_ID)}`)),
    );

    const row = (await db.select().from(processedPosts).where(eq(processedPosts.id, post.id)))[0]!;
    expect(row.approvalPayload!.overflowMessage).toBeUndefined();
  });

  it('refuses a caption over the Telegram limit', async () => {
    const post = await insertAwaitingPost();

    const response = await withEnv(routeEnv, () =>
      POST(
        postRequest(
          { postId: post.id, caption: 'x'.repeat(TELEGRAM_CAPTION_LIMIT + 1) },
          `tma ${initDataFor(REVIEWER_ID)}`,
        ),
      ),
    );

    expect(response.status).toBe(422);
    const row = (await db.select().from(processedPosts).where(eq(processedPosts.id, post.id)))[0]!;
    expect(row.approvalPayload!.caption).toBe('Original caption');
  });

  it('accepts a caption exactly at the limit', async () => {
    const post = await insertAwaitingPost();

    const response = await withEnv(routeEnv, () =>
      POST(
        postRequest(
          { postId: post.id, caption: 'x'.repeat(TELEGRAM_CAPTION_LIMIT) },
          `tma ${initDataFor(REVIEWER_ID)}`,
        ),
      ),
    );

    expect(response.status).toBe(200);
  });

  it.each([[''], ['   '], ['\n\n']])('refuses a blank caption %p', async (caption) => {
    const post = await insertAwaitingPost();

    const response = await withEnv(routeEnv, () =>
      POST(postRequest({ postId: post.id, caption }, `tma ${initDataFor(REVIEWER_ID)}`)),
    );

    expect(response.status).toBe(422);
  });

  it('refuses once the post has been published', async () => {
    const post = await insertAwaitingPost();
    await db
      .update(processedPosts)
      .set({ status: 'published' })
      .where(eq(processedPosts.id, post.id));

    const response = await withEnv(routeEnv, () =>
      POST(postRequest({ postId: post.id, caption: 'too late' }, `tma ${initDataFor(REVIEWER_ID)}`)),
    );

    expect(response.status).toBe(409);
  });

  it('refuses another tenant\'s post', async () => {
    await db.insert(workspaces).values({
      id: OTHER_WORKSPACE,
      name: 'second',
      telegramChatId: '-1002000000002',
      telegramAdminChatId: '777002',
    });
    const theirs = await insertAwaitingPost({ workspaceId: OTHER_WORKSPACE });

    const response = await withEnv(routeEnv, () =>
      POST(postRequest({ postId: theirs.id, caption: 'not yours' }, `tma ${initDataFor(REVIEWER_ID)}`)),
    );

    expect(response.status).toBe(409);
    const row = (await db.select().from(processedPosts).where(eq(processedPosts.id, theirs.id)))[0]!;
    expect(row.approvalPayload!.caption).toBe('Original caption');
  });

  it('refuses a malformed body', async () => {
    const response = await withEnv(routeEnv, () =>
      POST(postRequest({ postId: 'one', caption: 5 }, `tma ${initDataFor(REVIEWER_ID)}`)),
    );
    expect(response.status).toBe(400);
  });

  it('refuses expired init data', async () => {
    const post = await insertAwaitingPost();
    const stale = Math.floor(Date.now() / 1000) - 60 * 60 * 48;

    const response = await withEnv(routeEnv, () =>
      POST(
        postRequest(
          { postId: post.id, caption: 'replayed' },
          `tma ${initDataFor(REVIEWER_ID, { authDate: stale })}`,
        ),
      ),
    );

    expect(response.status).toBe(401);
  });
});

describeIfDb('the full-text preview of a long post', () => {
  it('is marked as not to be published once an edit replaces it', async () => {
    const post = await insertAwaitingPost({ overflowMessage: 'The whole long text.' });
    await db
      .update(processedPosts)
      .set({ approvalPayload: { ...post.approvalPayload!, adminOverflowMessageId: 31 } })
      .where(eq(processedPosts.id, post.id));

    const calls: { method: string; body: Record<string, unknown> }[] = [];
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

    try {
      const response = await withEnv(routeEnv, () =>
        POST(postRequest({ postId: post.id, caption: 'Mine' }, `tma ${initDataFor(REVIEWER_ID)}`)),
      );
      expect(response.status).toBe(200);
    } finally {
      vi.unstubAllGlobals();
    }

    const edit = calls.find((call) => call.method === 'editMessageText');
    expect(edit?.body.message_id).toBe(31);
    expect(edit?.body.text).toContain('will not be published');

    const row = (await db.select().from(processedPosts).where(eq(processedPosts.id, post.id)))[0]!;
    expect(row.approvalPayload!.overflowMessage).toBeUndefined();
    expect(row.approvalPayload!.adminOverflowMessageId).toBeUndefined();
  });
});
