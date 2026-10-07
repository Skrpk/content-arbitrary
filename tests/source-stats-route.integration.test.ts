import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  type PostStatus,
  type RejectionReason,
} from '@/db/schema';
import { GET } from '@/app/api/telegram/webapp/source-stats/route';
import { ensureTestWorkspace, withEnv } from './helpers';

/**
 * The source stats Mini App endpoint end to end: a signed request, counts
 * per source over a period, and nothing from another tenant.
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

interface StatsBody {
  period: string;
  postReadUsd: number;
  reasonLabels: Record<string, string>;
  channels: {
    id: number;
    name: string;
    sources: {
      sourceId: number;
      username: string;
      enabled: boolean;
      posts: number;
      approved: number;
      rejected: number;
      waiting: number;
      notSent: number;
      approvalRate: number | null;
      rejectionReasons: { reason: string | null; count: number }[];
      readCostUsd: number;
      costPerApprovedUsd: number | null;
      lastPostAt: string | null;
    }[];
  }[];
}

function stats(query = '', userId = REVIEWER_ID) {
  return withEnv(routeEnv, () =>
    GET(
      new Request(`https://example.vercel.app/api/telegram/webapp/source-stats${query}`, {
        headers: { authorization: `tma ${initDataFor(userId)}` },
      }),
    ),
  );
}

async function addSource(username: string, options: { workspaceId?: number; enabled?: boolean } = {}) {
  const rows = await db
    .insert(sources)
    .values({
      workspaceId: options.workspaceId ?? DEFAULT_WORKSPACE_ID,
      externalId: `${username}-id`,
      username,
      enabled: options.enabled ?? true,
    })
    .returning();
  return rows[0]!;
}

let nextPostId = 1_900_000_000_000_000_000n;

async function addPost(
  source: { id: number; workspaceId: number },
  status: PostStatus,
  options: { reason?: RejectionReason; daysAgo?: number } = {},
) {
  nextPostId += 1n;
  await db.insert(processedPosts).values({
    workspaceId: source.workspaceId,
    sourceId: source.id,
    xPostId: String(nextPostId),
    xPostUrl: `https://x.com/someone/status/${nextPostId}`,
    status,
    rejectionReason: status === 'rejected' ? (options.reason ?? null) : null,
    createdAt: new Date(Date.now() - (options.daysAgo ?? 1) * 24 * 60 * 60 * 1000),
  });
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

describeIfDb('GET /api/telegram/webapp/source-stats', () => {
  it('counts what each source brought in and what became of it', async () => {
    const busy = await addSource('busy');
    await addPost(busy, 'published');
    await addPost(busy, 'scheduled');
    await addPost(busy, 'rejected', { reason: 'wrong_topic' });
    await addPost(busy, 'rejected', { reason: 'wrong_topic' });
    await addPost(busy, 'rejected', { reason: 'too_minor' });
    await addPost(busy, 'rejected');
    await addPost(busy, 'awaiting_approval');
    await addPost(busy, 'skipped');

    const response = await stats();
    expect(response.status).toBe(200);
    const body = (await response.json()) as StatsBody;

    const [entry] = body.channels[0]!.sources;
    expect(entry).toMatchObject({
      username: 'busy',
      posts: 8,
      approved: 2,
      rejected: 4,
      waiting: 1,
      notSent: 1,
      approvalRate: 2 / 6,
      readCostUsd: 8 * body.postReadUsd,
      costPerApprovedUsd: (8 * body.postReadUsd) / 2,
    });
    expect(entry!.rejectionReasons).toEqual([
      { reason: 'wrong_topic', count: 2 },
      expect.objectContaining({ count: 1 }),
      expect.objectContaining({ count: 1 }),
    ]);
    expect(entry!.rejectionReasons.map((item) => item.reason).sort()).toEqual(
      ['too_minor', 'wrong_topic', null].sort(),
    );
    expect(new Date(entry!.lastPostAt!).getTime()).toBeLessThan(Date.now());
    expect(body.reasonLabels.wrong_topic).toBeTruthy();
  });

  it('lists an idle or paused source too, with nothing to rate yet', async () => {
    await addSource('quiet', { enabled: false });

    const body = (await (await stats()).json()) as StatsBody;

    expect(body.channels[0]!.sources).toEqual([
      expect.objectContaining({
        username: 'quiet',
        enabled: false,
        posts: 0,
        approvalRate: null,
        costPerApprovedUsd: null,
        lastPostAt: null,
        rejectionReasons: [],
      }),
    ]);
  });

  it('counts only the chosen period, last 7 days by default', async () => {
    const source = await addSource('steady');
    await addPost(source, 'published', { daysAgo: 2 });
    await addPost(source, 'rejected', { daysAgo: 20, reason: 'too_minor' });
    await addPost(source, 'rejected', { daysAgo: 60, reason: 'too_minor' });

    const count = async (query: string) =>
      ((await (await stats(query)).json()) as StatsBody).channels[0]!.sources[0]!;

    expect(((await (await stats()).json()) as StatsBody).period).toBe('7d');
    expect(await count('')).toMatchObject({ posts: 1, rejectionReasons: [] });
    expect(await count('?period=30d')).toMatchObject({ posts: 2, rejected: 1 });
    expect(await count('?period=all')).toMatchObject({
      posts: 3,
      rejectionReasons: [{ reason: 'too_minor', count: 2 }],
    });
    expect((await stats('?period=1y')).status).toBe(400);
  });

  it('shows a reviewer only their own channels', async () => {
    await addSource('mine');
    const theirs = await addSource('theirs', { workspaceId: OTHER_WORKSPACE });
    await addPost(theirs, 'published');

    const body = (await (await stats()).json()) as StatsBody;

    expect(body.channels.map((channel) => channel.id)).toEqual([DEFAULT_WORKSPACE_ID]);
    expect(body.channels[0]!.sources.map((source) => source.username)).toEqual(['mine']);
  });

  it('refuses anyone who reviews no channel', async () => {
    expect((await stats('', STRANGER_ID)).status).toBe(401);
  });
});
