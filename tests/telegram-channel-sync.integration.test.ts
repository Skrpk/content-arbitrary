import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import { DEFAULT_WORKSPACE_ID, processedPosts, sources, syncState, telegramMessages, workspaces } from '@/db/schema';
import { ChannelPageError } from '@/lib/errors';
import { loadReviewQueue } from '@/lib/review/queue';
import { NOT_A_PUBLIC_CHANNEL } from '@/lib/sources/add-telegram';
import { loadSourceStats } from '@/lib/sources/stats';
import { publishDecidedPost } from '@/lib/sync/publish';
import { syncPosts } from '@/lib/sync/sync-posts';
import { TelegramClient } from '@/lib/telegram/client';
import { dispatchCommand } from '@/lib/telegram/commands';
import { XClient } from '@/lib/x/client';
import { CDN, channelEmbed, channelPage, type FakeMessage } from './channel-page-fakes';
import { createTestLogger, ensureTestWorkspace, instantSleep, POSTED_AT, testDestination, withEnv } from './helpers';

/**
 * Public Telegram channels through the whole pipeline, against a real
 * database: t.me, its CDN and the Bot API are stubbed; cursors, claims, the
 * review queue and publishing are real.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  if (!connectionString) return;
  sql = postgres(connectionString, { max: 8, prepare: false });
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
  pages.clear();
});

// --- t.me, its CDN, and the Bot API --------------------------------------------

/** What each t.me URL answers with, set per test. */
const pages = new Map<string, string>();
const BEFORE = '2020-01-01T00:00:00+00:00';

function stack() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const pageRequests: string[] = [];
  const downloads: string[] = [];
  let messageId = 700;

  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://t.me/')) {
      pageRequests.push(url);
      const page = pages.get(url);
      return page === undefined
        ? new Response(null, { status: 302, headers: { location: 'https://t.me/' } })
        : new Response(page, { status: 200 });
    }
    if (!url.includes('/bot')) {
      downloads.push(url);
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, ...new Array(253).fill(0)]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': '256' },
      });
    }

    const method = url.split('/').pop()!;
    const raw = init?.body;
    const body = (
      typeof raw === 'string' ? JSON.parse(raw) : raw ? Object.fromEntries((raw as FormData).entries()) : {}
    ) as Record<string, unknown>;
    calls.push({ method, body });
    messageId += 1;
    const chat = { id: Number(body.chat_id) };
    if (method === 'sendPhoto') {
      return Response.json({ ok: true, result: { message_id: messageId, chat, photo: [{ file_id: 'ONE', file_size: 900 }] } });
    }
    return Response.json({ ok: true, result: { message_id: messageId, chat } });
  });

  const client = new TelegramClient({
    token: '123456:TEST',
    baseUrl: 'https://api.telegram.example',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    attempts: 1,
    sleep: instantSleep,
  });

  return { client, calls, pageRequests, downloads, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const unusedX = () =>
  new XClient({
    bearerToken: 'fake',
    baseUrl: 'https://api.x.example',
    fetchImpl: vi.fn(async () => {
      throw new Error('X should not be called');
    }) as unknown as typeof fetch,
    attempts: 1,
  });

const approvalEnv = {
  DRY_RUN: 'false',
  REQUIRE_APPROVAL: 'true',
  TELEGRAM_ADMIN_CHAT_ID: '555001',
  TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(64),
  TELEGRAM_CHAT_ID: '-1003906212630',
  MAX_POSTS_PER_RUN: '5',
  // With a website to review on, posts collect in the review queue.
  APP_BASE_URL: 'https://radar.example',
};

async function sync(telegram = stack(), env: Record<string, string> = {}) {
  const summary = await withEnv({ ...approvalEnv, ...env }, (parsed) =>
    syncPosts({
      db,
      env: parsed,
      xClient: unusedX(),
      telegramClient: telegram.client,
      fetchImpl: telegram.fetchImpl,
      channelFetch: { fetchImpl: telegram.fetchImpl },
      logger: createTestLogger(),
      sleep: instantSleep,
      skipLock: true,
      translationProvider: null,
    }),
  );
  return { summary, telegram };
}

async function followChannel(options: { includeTextOnly?: boolean } = {}) {
  const [source] = await db
    .insert(sources)
    .values({
      workspaceId: DEFAULT_WORKSPACE_ID,
      platform: 'telegram',
      externalId: 'spacenews',
      username: 'spacenews',
      includeTextOnly: options.includeTextOnly ?? false,
    })
    .returning();
  return source!;
}

const showPage = (messages: FakeMessage[], query = '') => pages.set(`https://t.me/s/spacenews${query}`, channelPage(messages));
const cursor = async () => (await db.select().from(syncState).where(eq(syncState.source, 'telegram:spacenews')))[0]?.lastSeenPostId;
const old = (id: number): FakeMessage => ({ id, text: `Old post ${id}`, photos: [`${CDN}/old-${id}.jpg`], date: BEFORE });

// --- The tests -------------------------------------------------------------------

describeIfDb('a Telegram channel in the sync', () => {
  it('follows from now: what the channel already has is passed over, and the cursor set past it', async () => {
    await followChannel();
    showPage([old(10), old(11), old(12)]);

    const { summary, telegram } = await sync();

    expect(telegram.calls).toHaveLength(0);
    expect(telegram.downloads).toHaveLength(0);
    expect(summary.sources[0]).toMatchObject({ platform: 'telegram', checked: 3, skipped: 3, newPosts: 0 });
    expect(await db.select().from(processedPosts)).toHaveLength(0);
    expect(await cursor()).toBe('12');
  });

  it('then queues only the new posts it can publish, and moves the cursor past all it read', async () => {
    await followChannel();
    showPage([old(10), old(11), old(12)]);
    await sync();

    showPage([
      old(11),
      old(12),
      { id: 13, text: 'A comet <b>tonight</b>', photos: [`${CDN}/comet.jpg`], date: POSTED_AT, views: '5K' },
      { id: 14, text: 'Words only', date: POSTED_AT },
      { id: 15, text: 'Shared', photos: [`${CDN}/fwd.jpg`], forwarded: true, date: POSTED_AT },
      { id: 16, text: 'Huge clip', video: { src: null }, date: POSTED_AT },
    ]);
    const { summary } = await sync();

    expect(summary.sources[0]).toMatchObject({ checked: 4, newPosts: 1, awaitingApproval: 1, skipped: 3 });
    const rows = await db.select().from(processedPosts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      xPostId: 'tg:spacenews/13',
      xPostUrl: 'https://t.me/spacenews/13',
      xAuthorUsername: 'spacenews',
      status: 'awaiting_approval',
      sourceText: 'A comet tonight',
    });
    expect(rows[0]!.approvalPayload!.sourceMedia).toEqual([
      expect.objectContaining({ mediaKey: 'tg:spacenews/13', kind: 'photo', url: `${CDN}/comet.jpg` }),
    ]);
    expect(await cursor()).toBe('16');

    // On the queue page it is the channel's, by name and badge.
    const queue = await loadReviewQueue(db, (await db.select().from(workspaces).where(eq(workspaces.id, DEFAULT_WORKSPACE_ID)))[0]!);
    expect(queue.items[0]).toMatchObject({ platform: 'telegram', sourceLabel: '@spacenews', url: 'https://t.me/spacenews/13' });

    // And nothing is offered twice.
    const again = await sync();
    expect(again.summary.sources[0]).toMatchObject({ checked: 0, newPosts: 0 });
  });

  it('mirrors text posts too when the source is set to', async () => {
    await followChannel({ includeTextOnly: true });
    showPage([old(1)]);
    await sync();
    showPage([old(1), { id: 2, text: 'Words only', date: POSTED_AT }]);

    const { summary } = await sync();

    expect(summary.sources[0]).toMatchObject({ newPosts: 1, awaitingApproval: 1 });
  });

  it('reads back page by page to the cursor when the channel posted more than a page', async () => {
    await followChannel();
    showPage([old(11), old(12)]);
    await sync();

    const text = (id: number): FakeMessage => ({ id, text: `Words ${id}`, date: POSTED_AT });
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => text(from + i));
    showPage(range(40, 59));
    showPage(range(20, 39), '?before=40');
    showPage([old(12), ...range(13, 19)], '?before=20');

    const { summary, telegram } = await sync();

    expect(telegram.pageRequests).toEqual([
      'https://t.me/s/spacenews',
      'https://t.me/s/spacenews?before=40',
      'https://t.me/s/spacenews?before=20',
    ]);
    expect(summary.sources[0]).toMatchObject({ checked: 47, skipped: 47 });
    expect(await cursor()).toBe('59');
  });

  it('reports a channel that has gone private or been renamed, and carries on', async () => {
    await followChannel();
    const { summary } = await sync();

    expect(summary.sources[0]!.error).toContain('No public channel by that name');
    expect(summary.error).toContain('@spacenews');
  });

  it('counts in the source stats as a free read', async () => {
    const source = await followChannel();
    const [stats] = await loadSourceStats(db, { workspaceIds: [DEFAULT_WORKSPACE_ID], since: null });
    expect(stats).toMatchObject({ sourceId: source.id, platform: 'telegram', label: '@spacenews', channelUrl: 'https://t.me/spacenews', readCostUsd: null });
  });
});

describeIfDb('publishing a queued channel post', () => {
  async function queued() {
    await followChannel();
    showPage([old(12)]);
    await sync();
    showPage([old(12), { id: 13, text: 'A comet', photos: [`${CDN}/comet.jpg?token=stale`], date: POSTED_AT }]);
    await sync();
    return (await db.select().from(processedPosts))[0]!;
  }

  it("looks its media up again on the post's own page, and sends what is there now", async () => {
    const row = await queued();
    pages.set(
      'https://t.me/spacenews/13?embed=1&mode=tme',
      channelEmbed({ id: 13, text: 'A comet', photos: [`${CDN}/comet.jpg?token=fresh`], date: POSTED_AT }),
    );
    const channel = stack();

    await withEnv(approvalEnv, (env) =>
      publishDecidedPost({
        db,
        env,
        client: channel.client,
        row,
        payload: row.approvalPayload!,
        destination: testDestination(env),
        fetchImpl: channel.fetchImpl,
        logger: createTestLogger(),
      }),
    );

    expect(channel.downloads).toEqual([`${CDN}/comet.jpg?token=fresh`]);
    expect(channel.calls.map((call) => call.method)).toEqual(['sendPhoto']);
    expect((await db.select().from(processedPosts))[0]!.status).toBe('published');
  });

  it('fails, sending nothing, when the channel has deleted the post', async () => {
    const row = await queued();
    const channel = stack();

    const error = await withEnv(approvalEnv, (env) =>
      publishDecidedPost({
        db,
        env,
        client: channel.client,
        row,
        payload: row.approvalPayload!,
        destination: testDestination(env),
        fetchImpl: channel.fetchImpl,
      }),
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(ChannelPageError);
    expect(channel.calls).toHaveLength(0);
  });
});

describeIfDb('/addtelegram', () => {
  const add = (args: string, telegram = stack()) =>
    dispatchCommand(
      {
        db,
        xClient: unusedX(),
        logger: createTestLogger(),
        workspaceId: DEFAULT_WORKSPACE_ID,
        workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: 'first' }],
        channelFetch: { fetchImpl: telegram.fetchImpl },
      },
      { command: 'addtelegram', args },
    );
  const channelSources = () => db.select().from(sources).where(eq(sources.platform, 'telegram'));

  it('adds a public channel under its lower-cased username, from a link as well as a name', async () => {
    showPage([old(1)]);

    const reply = await add('https://t.me/s/SpaceNews');

    expect(reply?.text).toContain('Telegram channel added');
    expect(reply?.text).toContain('Space News · @spacenews');
    expect(await channelSources()).toEqual([
      expect.objectContaining({ externalId: 'spacenews', username: 'spacenews', workspaceId: DEFAULT_WORKSPACE_ID }),
    ]);
    expect((await add('@spacenews'))?.text).toContain('already in your sources');
  });

  it('turns away what has no public page, and invite links, storing nothing', async () => {
    expect((await add('@ghostchannel'))?.text).toContain(NOT_A_PUBLIC_CHANNEL.slice(0, 40));
    expect((await add('https://t.me/+AbCdEf'))?.text).toContain('private channel');
    expect(await channelSources()).toEqual([]);
  });

  it('points a t.me link given to /addsource the right way', async () => {
    const reply = await dispatchCommand(
      { db, xClient: unusedX(), logger: createTestLogger(), workspaceId: DEFAULT_WORKSPACE_ID },
      { command: 'addsource', args: 't.me/spacenews' },
    );
    expect(reply?.text).toContain('/addtelegram');
  });
});
