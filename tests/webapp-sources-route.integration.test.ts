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
} from '@/db/schema';
import { DELETE, GET, POST } from '@/app/api/telegram/webapp/sources/route';
import { POST as ADD_RSS } from '@/app/api/telegram/webapp/sources/rss/route';

// The feed a test adds, without the network: only fetching is replaced.
const feedXml = vi.hoisted(() => ({ value: '' }));
vi.mock('@/lib/rss/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rss/client')>()),
  fetchFeed: async (url: string) => ({ xml: feedXml.value, finalUrl: url }),
}));
import { ensureTestWorkspace, withEnv } from './helpers';

/**
 * The settings Mini App endpoint end to end: a signed request, the tenant
 * lookup, and a write scoped to that tenant's own sources.
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

const routeEnv = {
  DATABASE_URL: connectionString,
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_CHAT_ID: '-1001000000001',
  TELEGRAM_ADMIN_CHAT_ID: String(REVIEWER_ID),
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

function list(authorization = auth()) {
  return withEnv(routeEnv, () =>
    GET(
      new Request('https://example.vercel.app/api/telegram/webapp/sources', {
        headers: { authorization },
      }),
    ),
  );
}

function change(body: unknown, authorization = auth()) {
  return withEnv(routeEnv, () =>
    POST(
      new Request('https://example.vercel.app/api/telegram/webapp/sources', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization },
        body: JSON.stringify(body),
      }),
    ),
  );
}

function remove(body: unknown, authorization = auth()) {
  return withEnv(routeEnv, () =>
    DELETE(
      new Request('https://example.vercel.app/api/telegram/webapp/sources', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', authorization },
        body: JSON.stringify(body),
      }),
    ),
  );
}

async function addSource(username: string, workspaceId = DEFAULT_WORKSPACE_ID) {
  const rows = await db
    .insert(sources)
    .values({ workspaceId, externalId: `${username}-id`, username })
    .returning();
  return rows[0]!;
}

async function reload(id: number) {
  return (await db.select().from(sources).where(eq(sources.id, id)))[0]!;
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

describeIfDb('GET /api/telegram/webapp/sources', () => {
  it('lists only the reviewer\'s own sources, with their settings', async () => {
    const mine = await addSource('alpha');
    await addSource('beta', OTHER_WORKSPACE);

    const response = await list();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      channels: [
        {
          id: DEFAULT_WORKSPACE_ID,
          name: 'default',
          reviewDigestMinutes: 60,
          sources: [
            {
              id: mine.id,
              platform: 'x',
              username: 'alpha',
              label: '@alpha',
              feedUrl: null,
              enabled: true,
              includeTextOnly: false,
            },
          ],
        },
      ],
    });
  });

  it('refuses a validly signed user who reviews for nobody', async () => {
    expect((await list(auth(STRANGER_ID))).status).toBe(401);
  });
});

describeIfDb('POST /api/telegram/webapp/sources', () => {
  it('turns text-only posts on, and off again', async () => {
    const source = await addSource('alpha');

    const on = await change({ sourceId: source.id, includeTextOnly: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({
      source: {
        id: source.id,
        platform: 'x',
        username: 'alpha',
        label: '@alpha',
        feedUrl: null,
        enabled: true,
        includeTextOnly: true,
      },
    });
    expect((await reload(source.id)).includeTextOnly).toBe(true);

    await change({ sourceId: source.id, includeTextOnly: false });
    expect((await reload(source.id)).includeTextOnly).toBe(false);
  });

  it('pauses a source without touching its other settings', async () => {
    const source = await addSource('alpha');
    await change({ sourceId: source.id, includeTextOnly: true });

    await change({ sourceId: source.id, enabled: false });

    const after = await reload(source.id);
    expect(after.enabled).toBe(false);
    expect(after.includeTextOnly).toBe(true);
  });

  it('cannot change another tenant\'s source', async () => {
    const theirs = await addSource('beta', OTHER_WORKSPACE);

    const response = await change({ sourceId: theirs.id, includeTextOnly: true });

    expect(response.status).toBe(404);
    expect((await reload(theirs.id)).includeTextOnly).toBe(false);
  });

  it('lets a stranger change nothing', async () => {
    const source = await addSource('alpha');

    const response = await change({ sourceId: source.id, includeTextOnly: true }, auth(STRANGER_ID));

    expect(response.status).toBe(401);
    expect((await reload(source.id)).includeTextOnly).toBe(false);
  });

  it.each<[Record<string, unknown>, string]>([
    [{ sourceId: 1 }, 'nothing to change'],
    [{ sourceId: 1, includeTextOnly: 'yes' }, 'a non-boolean value'],
    [{ sourceId: 1, workspaceId: 2, enabled: true }, 'a field that is not a setting'],
  ])('refuses %j (%s)', async (body) => {
    const source = await addSource('alpha');
    const response = await change({ ...body, sourceId: source.id });

    expect(response.status).toBe(400);
    expect(await reload(source.id)).toMatchObject({ enabled: true, includeTextOnly: false });
  });
});

describeIfDb('DELETE /api/telegram/webapp/sources', () => {
  const exists = async (id: number) =>
    (await db.select().from(sources).where(eq(sources.id, id))).length === 1;

  it('removes the source, and keeps its posts and cursor', async () => {
    const source = await addSource('alpha');
    await db.insert(processedPosts).values({
      workspaceId: DEFAULT_WORKSPACE_ID,
      sourceId: source.id,
      xPostId: '1',
      xPostUrl: 'https://x.com/alpha/status/1',
      status: 'published',
    });
    await db.insert(syncState).values({ source: 'x:alpha-id', workspaceId: DEFAULT_WORKSPACE_ID, lastSeenPostId: '1' });

    const response = await remove({ sourceId: source.id });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: source.id });
    expect(await exists(source.id)).toBe(false);
    expect(await db.select().from(processedPosts)).toEqual([expect.objectContaining({ sourceId: null })]);
    expect(await db.select().from(syncState)).toHaveLength(1);
  });

  it('cannot remove another tenant\'s source', async () => {
    const theirs = await addSource('beta', OTHER_WORKSPACE);

    expect((await remove({ sourceId: theirs.id })).status).toBe(404);
    expect(await exists(theirs.id)).toBe(true);
  });

  it('lets a stranger remove nothing', async () => {
    const source = await addSource('alpha');

    expect((await remove({ sourceId: source.id }, auth(STRANGER_ID))).status).toBe(401);
    expect(await exists(source.id)).toBe(true);
  });

  it.each([[{}], [{ sourceId: 'one' }], [{ sourceId: 1, workspaceId: 2 }]])('refuses %j', async (body) => {
    const source = await addSource('alpha');

    expect((await remove(body)).status).toBe(400);
    expect(await exists(source.id)).toBe(true);
  });
});

describeIfDb('POST /api/telegram/webapp/sources/rss', () => {
  const FEED = 'https://www.esa.int/rssfeed/Our_Activities/Space_Science';
  const add = (body: unknown, authorization = auth()) =>
    withEnv(routeEnv, () =>
      ADD_RSS(
        new Request('https://example.vercel.app/api/telegram/webapp/sources/rss', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization },
          body: JSON.stringify(body),
        }),
      ),
    );

  beforeEach(() => {
    feedXml.value =
      '<?xml version="1.0"?><rss version="2.0"><channel><title>ESA Space Science</title>' +
      '<item><title>A</title><guid>a</guid></item><item><title>B</title><guid>b</guid></item></channel></rss>';
  });

  it('adds a feed to the channel picked, and lists it as a feed', async () => {
    const response = await add({ url: FEED, workspaceId: DEFAULT_WORKSPACE_ID });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      created: true,
      entries: 2,
      workspaceId: DEFAULT_WORKSPACE_ID,
      source: { platform: 'rss', label: 'ESA Space Science', feedUrl: FEED, enabled: true },
    });

    const listed = (await (await list()).json()) as { channels: { sources: { platform: string; label: string }[] }[] };
    expect(listed.channels[0]!.sources).toEqual([
      expect.objectContaining({ platform: 'rss', label: 'ESA Space Science', feedUrl: FEED }),
    ]);
  });

  it('refuses another tenant’s channel, a page that is not a feed, and a stranger', async () => {
    expect((await add({ url: FEED, workspaceId: OTHER_WORKSPACE })).status).toBe(404);

    feedXml.value = '<html><body>not a feed</body></html>';
    const notFeed = await add({ url: FEED, workspaceId: DEFAULT_WORKSPACE_ID });
    expect(notFeed.status).toBe(422);
    expect(((await notFeed.json()) as { error: string }).error).toContain('does not appear to be a valid RSS');

    expect((await add({ url: FEED, workspaceId: DEFAULT_WORKSPACE_ID }, auth(STRANGER_ID))).status).toBe(401);
    expect((await add({ url: 'http://169.254.169.254/', workspaceId: DEFAULT_WORKSPACE_ID })).status).toBe(422);
    expect(await db.select().from(sources)).toEqual([]);
  });
});
