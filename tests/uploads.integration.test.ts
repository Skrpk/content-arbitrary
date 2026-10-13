import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import { DEFAULT_WORKSPACE_ID, postUploads, processedPosts, workspaces, type ApprovalPayload } from '@/db/schema';
import { createTestLogger, ensureTestWorkspace, withEnv } from './helpers';

/**
 * Photos and videos uploaded in the website's editor, end to end, with the
 * Blob store replaced: a file is recorded only when the store has it under
 * the post's path, of a type and size Telegram takes; a rich post places it
 * and publishing sends it; and the store lets it go once the post is out.
 */

const store = vi.hoisted(() => ({
  blobs: new Map<string, { url: string; pathname: string; contentType: string; size: number }>(),
  deleted: [] as string[],
}));

vi.mock('@vercel/blob', () => ({
  head: async (url: string) => {
    const blob = store.blobs.get(url);
    if (!blob) throw new Error('BlobNotFoundError');
    return { ...blob, uploadedAt: new Date() };
  },
  del: async (urls: string[] | string) => {
    for (const url of [urls].flat()) {
      store.deleted.push(url);
      store.blobs.delete(url);
    }
  },
}));

const { POST: registerRoute } = await import('@/app/api/telegram/webapp/uploads/register/route');
const { POST: tokenRoute } = await import('@/app/api/telegram/webapp/uploads/route');
const richRoute = await import('@/app/api/telegram/webapp/rich/route');
const { POST: decideRoute } = await import('@/app/api/telegram/webapp/queue/route');
const { sweepUploads, vercelBlobStore } = await import('@/lib/uploads/uploads');

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

const BOT_TOKEN = '123456:AAHfakeTokenForTestsOnly';
const REVIEWER_ID = 555001;
const STRANGER_ID = 777002;
const CHANNEL_CHAT = '-1003906212630';
const BLOB_HOST = 'https://store123.public.blob.vercel-storage.com';

const env = {
  DATABASE_URL: connectionString,
  DRY_RUN: 'false',
  REQUIRE_APPROVAL: 'true',
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(64),
  APP_BASE_URL: 'https://example.vercel.app',
  BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_store123_secretsecretsecret',
  MAX_VIDEO_SIZE_MB: '20',
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

const telegramCalls: { method: string; body: Record<string, unknown> }[] = [];
const fetched: string[] = [];

beforeEach(async () => {
  if (!connectionString) return;
  store.blobs.clear();
  store.deleted.length = 0;
  telegramCalls.length = 0;
  fetched.length = 0;
  await db.delete(processedPosts);
  await ensureTestWorkspace(db);
  await db
    .update(workspaces)
    .set({ telegramChatId: CHANNEL_CHAT, telegramAdminChatId: String(REVIEWER_ID) })
    .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
  // Telegram, and the store's files as publishing fetches them.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('/bot')) {
        fetched.push(url);
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, ...new Array(253).fill(0)]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': '256' },
        });
      }
      const raw = init?.body;
      const body = (typeof raw === 'string' ? JSON.parse(raw) : Object.fromEntries((raw as FormData).entries())) as Record<string, unknown>;
      telegramCalls.push({ method: url.split('/').pop()!, body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 500, chat: { id: Number(CHANNEL_CHAT) } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
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

const call = (
  route: (request: Request) => Promise<Response>,
  path: string,
  body?: unknown,
  options: { userId?: number; method?: string; env?: Record<string, string | undefined> } = {},
) =>
  withEnv({ ...env, ...options.env }, () =>
    route(
      new Request(`https://example.vercel.app${path}`, {
        method: options.method ?? 'POST',
        headers: { authorization: `tma ${initDataFor(options.userId ?? REVIEWER_ID)}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    ),
  );

const PAYLOAD: ApprovalPayload = {
  method: 'sendPhoto',
  caption: 'Bear',
  items: [],
  sourceMedia: [{ mediaKey: 'a', kind: 'photo', url: 'https://cdn.example/a.jpg', width: 1600, height: 1200 }],
};

let seq = 0;
async function post(overrides: Partial<typeof processedPosts.$inferInsert> = {}) {
  seq += 1;
  const [row] = await db
    .insert(processedPosts)
    .values({
      workspaceId: DEFAULT_WORKSPACE_ID,
      externalId: String(1_798_000_000_000_000_000n + BigInt(seq)),
      xPostUrl: `https://x.com/nasa/status/${seq}`,
      xAuthorUsername: 'nasa',
      status: 'awaiting_approval',
      approvalPayload: PAYLOAD,
      reviewQueuedAt: new Date(),
      caption: 'Bear',
      originalCaption: 'Bear',
      ...overrides,
    })
    .returning();
  return row!;
}

/** A file in the store, as the browser would have put it there. */
function stored(pathname: string, contentType = 'image/jpeg', size = 300_000) {
  const url = `${BLOB_HOST}/${pathname}`;
  store.blobs.set(url, { url, pathname, contentType, size });
  return url;
}

const register = (postId: number, url: string, options?: Parameters<typeof call>[3]) =>
  call(registerRoute, '/api/telegram/webapp/uploads/register', { postId, url }, options);

describeIfDb('recording an upload', () => {
  it('records a photo the store has under the post’s path, once', async () => {
    const row = await post();
    const url = stored(`posts/${row.id}/bear-x1y2.jpg`);

    const first = await register(row.id, url);
    expect(first.status).toBe(200);
    const body = (await first.json()) as { ref: string; kind: string; url: string };
    expect(body).toMatchObject({ kind: 'photo', url });
    expect(body.ref).toMatch(/^u\d+$/);

    expect(await (await register(row.id, url)).json()).toEqual(body);
    expect(await db.select().from(postUploads)).toHaveLength(1);
  });

  it('refuses a file of another post, of a type Telegram does not show, or too large — and lets the last two go', async () => {
    const row = await post();
    const other = await post();
    expect((await register(row.id, stored(`posts/${other.id}/a.jpg`))).status).toBe(422);
    expect((await register(row.id, `${BLOB_HOST}/posts/${row.id}/missing.jpg`)).status).toBe(422);

    const gif = stored(`posts/${row.id}/a.gif`, 'image/gif');
    expect(await (await register(row.id, gif)).json()).toEqual({ error: 'Only JPEG, PNG and WebP photos and MP4 videos can be uploaded.' });
    const huge = stored(`posts/${row.id}/big.mp4`, 'video/mp4', 21 * 1024 * 1024);
    expect(await (await register(row.id, huge)).json()).toEqual({ error: 'The video is 21.0 MB; the limit is 20.0 MB.' });
    expect(store.deleted).toEqual([gif, huge]);
    expect(await db.select().from(postUploads)).toHaveLength(0);
  });

  it('is for the post’s reviewer, while it waits, and only with a store set up', async () => {
    const row = await post();
    const url = stored(`posts/${row.id}/a.jpg`);
    expect((await register(row.id, url, { userId: STRANGER_ID })).status).toBe(401);
    expect((await register(row.id, url, { env: { BLOB_READ_WRITE_TOKEN: undefined } })).status).toBe(503);
    const done = await post({ status: 'published' });
    expect((await register(done.id, stored(`posts/${done.id}/a.jpg`))).status).toBe(409);
  });
});

describeIfDb('the upload token', () => {
  const tokenRequest = (postId: number, pathname: string) => ({
    type: 'blob.generate-client-token',
    payload: { pathname, callbackUrl: 'https://example.vercel.app/api/telegram/webapp/uploads', multipart: false, clientPayload: JSON.stringify({ postId }) },
  });

  it('is given to the reviewer for a path under the post, and refused for anything else', async () => {
    const row = await post();
    const given = await call(tokenRoute, '/api/telegram/webapp/uploads', tokenRequest(row.id, `posts/${row.id}/bear.jpg`));
    expect(given.status).toBe(200);
    expect(await given.json()).toMatchObject({ type: 'blob.generate-client-token', clientToken: expect.any(String) });

    expect((await call(tokenRoute, '/api/telegram/webapp/uploads', tokenRequest(row.id, 'posts/999/bear.jpg'))).status).toBe(400);
    expect(
      (await call(tokenRoute, '/api/telegram/webapp/uploads', tokenRequest(row.id, `posts/${row.id}/b.jpg`), { userId: STRANGER_ID })).status,
    ).toBe(401);
  });
});

describeIfDb('an upload in a rich post', () => {
  async function uploaded(rowId: number, name = 'a.jpg') {
    const body = (await (await register(rowId, stored(`posts/${rowId}/${name}`))).json()) as { ref: string; url: string };
    return body;
  }

  it('is in the editor beside the post’s own media, and can be placed in its layout', async () => {
    const row = await post();
    const upload = await uploaded(row.id);
    const editor = (await (await call(richRoute.GET, `/api/telegram/webapp/rich?post=${row.id}`, undefined, { method: 'GET' })).json()) as {
      media: unknown[];
      uploads: unknown;
    };
    expect(editor.media).toEqual([
      expect.objectContaining({ ref: 'm0', kind: 'photo' }),
      { ref: upload.ref, kind: 'photo', previewUrl: upload.url, videoUrl: null, uploaded: true },
    ]);
    expect(editor.uploads).toEqual({ pathPrefix: `posts/${row.id}/`, maxBytes: { photo: 10 * 1024 * 1024, video: 20 * 1024 * 1024 } });

    const doc = { type: 'doc', content: [{ type: 'postMedia', attrs: { ref: upload.ref, caption: 'Mine' } }] };
    expect((await call(richRoute.POST, '/api/telegram/webapp/rich', { postId: row.id, doc })).status).toBe(200);

    // Another post's upload is not this one's to place.
    const other = await post();
    expect((await call(richRoute.POST, '/api/telegram/webapp/rich', { postId: other.id, doc })).status).toBe(422);
  });

  it('is fetched from the store and sent with the post, and the post’s files are deleted once it is out', async () => {
    const row = await post();
    const placed = await uploaded(row.id, 'placed.jpg');
    const unused = await uploaded(row.id, 'unused.jpg');
    await db
      .update(processedPosts)
      .set({
        richDoc: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Look' }] },
            { type: 'postMedia', attrs: { ref: placed.ref, caption: null } },
          ],
        },
      })
      .where(eq(processedPosts.id, row.id));

    const response = await call(decideRoute, '/api/telegram/webapp/queue', { action: 'approve', postId: row.id });
    expect(response.status).toBe(200);

    expect(fetched).toEqual([placed.url]);
    const message = JSON.parse(String(telegramCalls[0]!.body.rich_message)) as { html: string; media: unknown[] };
    expect(message.html).toBe(`<p>Look</p><img src="tg://photo?id=${placed.ref}"/>`);
    expect(message.media).toEqual([{ id: placed.ref, media: { type: 'photo', media: `attach://upload_${placed.ref}` } }]);

    expect(store.deleted.sort()).toEqual([placed.url, unused.url].sort());
    expect((await db.select().from(postUploads)).every((upload) => upload.deletedAt instanceof Date)).toBe(true);
  });

  it('is swept from the store once its post is turned down, and kept while it waits', async () => {
    const waiting = await post();
    const turnedDown = await post();
    const kept = await uploaded(waiting.id);
    const gone = await uploaded(turnedDown.id);
    await db.update(processedPosts).set({ status: 'rejected' }).where(eq(processedPosts.id, turnedDown.id));

    expect(await sweepUploads(db as never, vercelBlobStore('token'), createTestLogger())).toBe(1);
    expect(store.deleted).toEqual([gone.url]);
    expect(store.blobs.has(kept.url)).toBe(true);
    expect(await sweepUploads(db as never, vercelBlobStore('token'), createTestLogger())).toBe(0);
  });
});
