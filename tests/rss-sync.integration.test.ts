import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import {
  DEFAULT_WORKSPACE_ID,
  processedPosts,
  radarEvaluations,
  sources,
  syncState,
  telegramMessages,
  workspaces,
} from '@/db/schema';
import { RADAR_PROMPT_BASELINE } from '@/lib/radar/prompt';
import { createRadarRun } from '@/lib/radar/shadow';
import { NOT_A_FEED } from '@/lib/sources/add-rss';
import { setSourceEnabled } from '@/lib/sources/repository';
import { loadSourceStats } from '@/lib/sources/stats';
import { publishApprovedPayload } from '@/lib/sync/approval';
import { RSS_BACKLOG_REASON } from '@/lib/sync/repository';
import { syncPosts } from '@/lib/sync/sync-posts';
import { TelegramClient } from '@/lib/telegram/client';
import { dispatchCommand } from '@/lib/telegram/commands';
import { XClient } from '@/lib/x/client';
import { createTestLogger, ensureTestWorkspace, instantSleep, POSTED_AT, withEnv } from './helpers';
import { fakeAnthropic, fakeOpenAi, messageResponse, radarOutput, responsesResponse } from './radar-fakes';

/**
 * RSS / Atom feeds through the whole pipeline, against a real database: the
 * feed and Telegram are stubbed; claims, backlog, dedup and isolation are real.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

const FEED_URL = 'https://www.esa.int/rssfeed/Our_Activities/Space_Science';
const OTHER_WORKSPACE = 2;

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
  await db.delete(radarEvaluations);
  await db.delete(telegramMessages);
  await db.delete(processedPosts);
  await db.delete(syncState);
  await db.delete(sources);
  await ensureTestWorkspace(db);
  feeds.clear();
});

// --- The feed -----------------------------------------------------------------

interface Item {
  guid: string;
  title: string;
  date?: string;
}

const item = (n: number, date = `2026-10-0${(n % 9) + 1}T09:00:00Z`): Item => ({
  guid: `esa-${n}`,
  title: `Story number ${n}`,
  date,
});

function rss(items: Item[], title = 'ESA Space Science'): string {
  return (
    `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>https://www.esa.int/</link>` +
    items
      .map(
        (entry) =>
          `<item><title>${entry.title}</title><link>https://www.esa.int/${entry.guid}</link>` +
          `<guid isPermaLink="false">${entry.guid}</guid>` +
          `<description>All about ${entry.title.toLowerCase()}, in a sentence or two.</description>` +
          (entry.date ? `<pubDate>${new Date(entry.date).toUTCString()}</pubDate>` : '') +
          '</item>',
      )
      .join('') +
    '</channel></rss>'
  );
}

/** What each feed URL answers with, set per test. */
const feeds = new Map<string, string | (() => Response)>();
const feedFetch = {
  fetchImpl: vi.fn(async (input: unknown) => {
    const answer = feeds.get(String(input));
    if (answer === undefined) return new Response('no such feed', { status: 404 });
    return typeof answer === 'function' ? answer() : new Response(answer, { status: 200 });
  }) as unknown as typeof fetch,
  lookup: async () => ['93.184.215.14'],
};

// --- Telegram -----------------------------------------------------------------

function telegramStack() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let messageId = 500;

  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = url.split('/').pop()!;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ method, body });
    messageId += 1;
    return Response.json({ ok: true, result: { message_id: messageId, chat: { id: 555001 } } });
  });

  const client = new TelegramClient({
    token: '123456:TEST',
    baseUrl: 'https://api.telegram.example',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    attempts: 1,
    sleep: instantSleep,
  });

  return { client, calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

/** An X client for a test that has no X sources: any call is a mistake. */
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
};

async function sync(
  telegram = telegramStack(),
  options: Partial<Parameters<typeof syncPosts>[0]> = {},
  env: Record<string, string | undefined> = {},
) {
  const summary = await withEnv({ ...approvalEnv, ...env }, (parsed) =>
    syncPosts({
      db,
      env: parsed,
      xClient: unusedX(),
      telegramClient: telegram.client,
      fetchImpl: telegram.fetchImpl,
      feedFetch,
      logger: createTestLogger(),
      sleep: instantSleep,
      skipLock: true,
      translationProvider: null,
      ...options,
    }),
  );
  return { summary, telegram };
}

async function followFeed(workspaceId = DEFAULT_WORKSPACE_ID, url = FEED_URL) {
  const [source] = await db
    .insert(sources)
    .values({ workspaceId, platform: 'rss', externalId: url, username: 'ESA Space Science' })
    .returning();
  return source!;
}

const reviews = (calls: { method: string; body: Record<string, unknown> }[]) =>
  calls.filter((call) => call.method === 'sendMessage' && call.body.reply_markup).length;

// --- The tests ----------------------------------------------------------------

describeIfDb('an RSS source in the sync', () => {
  it('records what the feed holds when followed, and sends none of it', async () => {
    await followFeed();
    feeds.set(FEED_URL, rss([item(3), item(2), item(1)]));

    const { summary, telegram } = await sync();

    expect(telegram.calls).toHaveLength(0);
    expect(summary.sources[0]).toMatchObject({ platform: 'rss', checked: 3, skipped: 3, newPosts: 0 });
    const rows = await db.select().from(processedPosts);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.status === 'skipped' && row.errorMessage === RSS_BACKLOG_REASON)).toBe(true);
    expect(rows.every((row) => row.sourceText === null)).toBe(true);
  });

  it('then sends nothing while the feed is unchanged, and exactly the one new entry when one appears', async () => {
    await followFeed();
    feeds.set(FEED_URL, rss([item(3), item(2), item(1)]));
    await sync();

    expect((await sync()).telegram.calls).toHaveLength(0);

    feeds.set(FEED_URL, rss([item(4), item(3), item(2), item(1)]));
    const { telegram } = await sync();

    expect(reviews(telegram.calls)).toBe(1);
    const [preview, control] = telegram.calls;
    // The post as the channel would get it: the entry, then the article, previewed.
    expect(preview!.body.text).toBe(
      'Story number 4\n\nAll about story number 4, in a sentence or two.\n\nhttps://www.esa.int/esa-4',
    );
    expect(preview!.body.link_preview_options).toEqual({ url: 'https://www.esa.int/esa-4' });
    // The buttons' message names the feed — without an @ — and links the article.
    expect(control!.body.text).toContain('Source: ESA Space Science\nhttps://www.esa.int/esa-4');
    expect(control!.body.text).not.toContain('@ESA');

    const [row] = await db.select().from(processedPosts).where(eq(processedPosts.status, 'awaiting_approval'));
    expect(row).toMatchObject({
      xPostUrl: 'https://www.esa.int/esa-4',
      xAuthorUsername: 'ESA Space Science',
      sourceText: 'Story number 4\n\nAll about story number 4, in a sentence or two.',
    });
    expect(row!.xPostId).toMatch(/^rss:/);
  });

  it('publishes an approved entry with its article link and preview', async () => {
    await followFeed();
    feeds.set(FEED_URL, rss([item(1)]));
    await sync();
    feeds.set(FEED_URL, rss([item(2), item(1)]));
    await sync();

    const [row] = await db.select().from(processedPosts).where(eq(processedPosts.status, 'awaiting_approval'));
    const channel = telegramStack();
    await publishApprovedPayload(
      { client: channel.client, chatId: '-1003906212630', disableNotification: false },
      row!.approvalPayload!,
    );

    expect(channel.calls[0]!.method).toBe('sendMessage');
    expect(channel.calls[0]!.body.text).toContain('https://www.esa.int/esa-2');
    expect(channel.calls[0]!.body.link_preview_options).toEqual({ url: 'https://www.esa.int/esa-2' });
  });

  it('offers nothing twice when the feed is reordered or lists an entry twice', async () => {
    await followFeed();
    feeds.set(FEED_URL, rss([item(2), item(1)]));
    await sync();
    feeds.set(FEED_URL, rss([item(3), item(2), item(1)]));
    await sync();

    feeds.set(FEED_URL, rss([item(1), item(3), item(2), item(3)]));
    const { telegram } = await sync();

    expect(telegram.calls).toHaveLength(0);
    expect(await db.select().from(processedPosts)).toHaveLength(3);
  });

  it('passes over what the feed got while the source was paused', async () => {
    const source = await followFeed();
    feeds.set(FEED_URL, rss([item(1)]));
    await sync();

    await setSourceEnabled(db, { id: source.id, enabled: false });
    feeds.set(FEED_URL, rss([item(6), item(5), item(4), item(3), item(2), item(1)]));
    expect((await sync()).telegram.calls).toHaveLength(0);

    await setSourceEnabled(db, { id: source.id, enabled: true });
    const resumed = await sync();
    expect(resumed.telegram.calls).toHaveLength(0);
    expect(resumed.summary.sources[0]).toMatchObject({ skipped: 6, newPosts: 0 });

    feeds.set(FEED_URL, rss([item(7), item(6), item(5), item(4), item(3), item(2), item(1)]));
    expect(reviews((await sync()).telegram.calls)).toBe(1);
  });

  it('sends a new entry once, even to two runs at the same time', async () => {
    await followFeed();
    feeds.set(FEED_URL, rss([item(1)]));
    await sync();
    feeds.set(FEED_URL, rss([item(2), item(1)]));

    const telegram = telegramStack();
    await Promise.all([sync(telegram), sync(telegram)]);

    expect(reviews(telegram.calls)).toBe(1);
  });

  it('keeps each workspace’s copy of the same feed to itself', async () => {
    await db.insert(workspaces).values({
      id: OTHER_WORKSPACE,
      name: 'second',
      telegramChatId: '-1002000000002',
      telegramAdminChatId: '777002',
    });
    await followFeed(DEFAULT_WORKSPACE_ID);
    await followFeed(OTHER_WORKSPACE);
    feeds.set(FEED_URL, rss([item(1)]));
    await sync();

    feeds.set(FEED_URL, rss([item(2), item(1)]));
    const { telegram } = await sync();

    expect(reviews(telegram.calls)).toBe(2);
    expect(telegram.calls.filter((call) => call.body.reply_markup).map((call) => call.body.chat_id).sort()).toEqual(
      ['555001', '777002'],
    );
    const newRows = await db.select().from(processedPosts).where(eq(processedPosts.status, 'awaiting_approval'));
    expect(newRows.map((row) => row.workspaceId).sort()).toEqual([DEFAULT_WORKSPACE_ID, OTHER_WORKSPACE]);
    expect(new Set(newRows.map((row) => row.xPostId)).size).toBe(1);
  });

  it('does not let a broken feed stop an X account', async () => {
    await followFeed();
    feeds.set(FEED_URL, '<rss><channel><item>broken');
    await db.insert(sources).values({ platform: 'x', externalId: '999', username: 'esa_x' });

    const xClient = new XClient({
      bearerToken: 'fake',
      baseUrl: 'https://api.x.example',
      fetchImpl: vi.fn(async () =>
        Response.json({
          data: [
            {
              id: '1760000000000099001',
              text: 'A rare photo of Saturn',
              created_at: POSTED_AT,
              author_id: '999',
              attachments: { media_keys: ['3_a'] },
            },
          ],
          includes: {
            users: [{ id: '999', username: 'esa_x' }],
            media: [{ media_key: '3_a', type: 'photo', url: 'https://cdn.example/a.jpg', width: 1600, height: 1200 }],
          },
          meta: { result_count: 1, newest_id: '1760000000000099001' },
        }),
      ) as unknown as typeof fetch,
      attempts: 1,
    });
    const telegram = telegramStack();
    telegram.fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('api.telegram.example')) {
        return new Response(new Uint8Array(256), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      const method = url.split('/').pop()!;
      telegram.calls.push({ method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : {} });
      return Response.json({
        ok: true,
        result: { message_id: 9, chat: { id: 555001 }, photo: [{ file_id: 'F', file_size: 9 }] },
      });
    }) as unknown as typeof fetch;
    telegram.client = new TelegramClient({
      token: '123456:TEST',
      baseUrl: 'https://api.telegram.example',
      fetchImpl: telegram.fetchImpl,
      attempts: 1,
      sleep: instantSleep,
    });

    const { summary } = await sync(telegram, { xClient });

    const byPlatform = Object.fromEntries(summary.sources.map((source) => [source.platform, source]));
    expect(byPlatform.rss!.error).toMatch(/Not well-formed XML/);
    expect(byPlatform.x).toMatchObject({ awaitingApproval: 1 });
    expect(byPlatform.x!.error).toBeUndefined();
  });

  it('goes through Radar, which names the feed without an @', async () => {
    await db.update(workspaces).set({ editorialProfile: 'Space science.' }).where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
    await followFeed();
    feeds.set(FEED_URL, rss([item(1)]));
    await sync();
    feeds.set(FEED_URL, rss([item(2), item(1)]));

    const radar = fakeAnthropic(() => messageResponse(radarOutput({ score: 64 })));
    const { telegram } = await sync(telegramStack(), {
      radarRun: createRadarRun({ promptVersions: [RADAR_PROMPT_BASELINE], provider: radar.provider }),
    });

    const [evaluation] = await db.select().from(radarEvaluations);
    expect(evaluation).toMatchObject({ status: 'ok', score: 64, variant: 'text' });
    const prompt = JSON.stringify(radar.requests[0]);
    expect(prompt).toContain('source=\\"ESA Space Science\\"');
    expect(prompt).not.toContain('@ESA');
    expect(telegram.calls.at(-1)!.body.text).toContain('📡 Radar 64/100');
  });

  it('is rewritten in the workspace’s language, keeping the original as the source text', async () => {
    await db.update(workspaces).set({ language: 'uk' }).where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
    await followFeed();
    feeds.set(FEED_URL, rss([item(1)]));
    await sync();
    feeds.set(FEED_URL, rss([item(2), item(1)]));

    const model = fakeOpenAi(() => responsesResponse({ text: 'Історія номер 2' }));
    const { telegram } = await sync(telegramStack(), { translationProvider: model.provider });

    expect(telegram.calls[0]!.body.text).toBe('Історія номер 2\n\nhttps://www.esa.int/esa-2');
    const [row] = await db.select().from(processedPosts).where(eq(processedPosts.status, 'awaiting_approval'));
    expect(row!.sourceText).toBe('Story number 2\n\nAll about story number 2, in a sentence or two.');
  });

  it('follows a feed that renames itself', async () => {
    const source = await followFeed();
    feeds.set(FEED_URL, rss([item(1)], 'ESA — Space Science'));
    await sync();

    const [renamed] = await db.select().from(sources).where(eq(sources.id, source.id));
    expect(renamed!.username).toBe('ESA — Space Science');
  });

  it('shows in source stats without its backlog and without an X read cost', async () => {
    const source = await followFeed();
    feeds.set(FEED_URL, rss([item(3), item(2), item(1)]));
    await sync();
    feeds.set(FEED_URL, rss([item(4), item(3), item(2), item(1)]));
    await sync();

    const [stats] = await loadSourceStats(db, { workspaceIds: [DEFAULT_WORKSPACE_ID], since: null });
    expect(stats).toMatchObject({
      sourceId: source.id,
      platform: 'rss',
      label: 'ESA Space Science',
      feedUrl: FEED_URL,
      posts: 1,
      waiting: 1,
      notSent: 0,
      readCostUsd: null,
      costPerApprovedUsd: null,
    });
  });
});

describeIfDb('/addrss', () => {
  const context = (workspaceIds: number[] = [DEFAULT_WORKSPACE_ID]) => ({
    db,
    xClient: unusedX(),
    logger: createTestLogger(),
    workspaceId: workspaceIds[0]!,
    workspaces: workspaceIds.map((id) => ({ id, name: id === DEFAULT_WORKSPACE_ID ? 'first' : 'second' })),
    feedFetch,
  });
  const addrss = (args: string, workspaceIds?: number[]) =>
    dispatchCommand(context(workspaceIds), { command: 'addrss', args });
  const rssSources = () => db.select().from(sources).where(eq(sources.platform, 'rss'));

  it('adds a valid feed under its title and normalised URL, and says nothing old will be sent', async () => {
    feeds.set(FEED_URL, rss([item(2), item(1)]));

    const reply = await addrss(`  ${FEED_URL}#latest `);

    expect(reply?.text).toContain('RSS source added');
    expect(reply?.text).toContain('ESA Space Science');
    expect(reply?.text).toContain('2 entries currently in the feed');
    expect(await rssSources()).toEqual([
      expect.objectContaining({ externalId: FEED_URL, username: 'ESA Space Science', workspaceId: DEFAULT_WORKSPACE_ID }),
    ]);
  });

  it('adds an Atom feed too', async () => {
    feeds.set(
      'https://www.jpl.nasa.gov/feeds/news.atom',
      '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>JPL News</title><id>x</id></feed>',
    );

    expect((await addrss('https://www.jpl.nasa.gov/feeds/news.atom'))?.text).toContain('JPL News');
  });

  it('turns away a page that is not a feed, and a local address, storing nothing', async () => {
    feeds.set('https://www.esa.int/', '<!doctype html><html><body>Home</body></html>');

    expect((await addrss('https://www.esa.int/'))?.text).toContain(NOT_A_FEED);
    expect((await addrss('http://localhost:8080/feed'))?.text).toContain('Local addresses are not allowed');
    expect(await rssSources()).toEqual([]);
  });

  it('asks a reviewer of several channels which one, and adds it to the one named', async () => {
    await db.insert(workspaces).values({ id: OTHER_WORKSPACE, name: 'second' });
    feeds.set(FEED_URL, rss([item(1)]));

    const asked = await addrss(FEED_URL, [DEFAULT_WORKSPACE_ID, OTHER_WORKSPACE]);
    expect(asked?.text).toContain(`${OTHER_WORKSPACE} — second`);
    expect(asked?.text).toContain(`/addrss ${DEFAULT_WORKSPACE_ID} ${FEED_URL}`);
    expect(await rssSources()).toEqual([]);

    await addrss(`${OTHER_WORKSPACE} ${FEED_URL}`, [DEFAULT_WORKSPACE_ID, OTHER_WORKSPACE]);
    expect((await rssSources()).map((source) => source.workspaceId)).toEqual([OTHER_WORKSPACE]);

    expect((await addrss(`99 ${FEED_URL}`, [DEFAULT_WORKSPACE_ID, OTHER_WORKSPACE]))?.text).toContain(
      'not one of yours',
    );
  });

  it('says so when the feed is already a source', async () => {
    feeds.set(FEED_URL, rss([item(1)]));
    await addrss(FEED_URL);

    expect((await addrss(FEED_URL))?.text).toContain('already in your sources');
    expect(
      await db
        .select()
        .from(sources)
        .where(and(eq(sources.platform, 'rss'), eq(sources.externalId, FEED_URL))),
    ).toHaveLength(1);
  });
});
