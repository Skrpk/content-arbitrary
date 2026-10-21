import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
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
import { NOT_A_SITEMAP } from '@/lib/sources/add-website';
import { setSourceEnabled } from '@/lib/sources/repository';
import { loadSourceStats } from '@/lib/sources/stats';
import { RSS_BACKLOG_REASON, WEBSITE_PAGE_REASON_PREFIX } from '@/lib/sync/repository';
import { syncPosts } from '@/lib/sync/sync-posts';
import { TelegramClient } from '@/lib/telegram/client';
import { dispatchCommand } from '@/lib/telegram/commands';
import { webItemId } from '@/lib/website/url';
import { XClient } from '@/lib/x/client';
import { createTestLogger, ensureTestWorkspace, instantSleep, withEnv } from './helpers';
import { fakeAnthropic, messageResponse, radarOutput } from './radar-fakes';

/**
 * A website, followed through its sitemap, through the whole pipeline against
 * a real database: the site and Telegram are stubbed; backlog, identity,
 * retries and isolation are real.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

const SITEMAP = 'https://news.example.com/sitemap.xml';
const FEED_URL = 'https://www.esa.int/rssfeed/Our_Activities/Space_Science';

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
  web.clear();
  asked.length = 0;
});

// --- The site -------------------------------------------------------------------

const pageUrl = (slug: string) => `https://news.example.com/2026/${slug}`;

function sitemap(slugs: (string | { slug: string; lastmod: string })[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    slugs
      .map((entry) => (typeof entry === 'string' ? { slug: entry, lastmod: new Date().toISOString() } : entry))
      .map((entry) => `<url><loc>${pageUrl(entry.slug)}</loc><lastmod>${entry.lastmod}</lastmod></url>`)
      .join('') +
    '</urlset>'
  );
}

function article(slug: string, publishedAt = new Date().toISOString()): string {
  const body = Array.from(
    { length: 5 },
    (_, i) =>
      `<p>Paragraph ${i + 1} of ${slug}: astronomers report a clear signal and explain at some length what the measurement means, and what comes next for the mission and the team behind it.</p>`,
  ).join('');
  return (
    `<!doctype html><html lang="en"><head><title>Headline of ${slug}</title>` +
    '<meta property="og:site_name" content="Example News">' +
    `<meta property="article:published_time" content="${publishedAt}">` +
    `<meta name="description" content="The lead of ${slug}: what happened, said in a sentence that is long enough to stand as the summary.">` +
    `</head><body><nav><a href="/">Home</a> <a href="/space">Space</a></nav><article><h1>Headline of ${slug}</h1>${body}</article>` +
    '<footer>© Example News</footer></body></html>'
  );
}

/** What each address answers with, set per test; every address asked for is recorded. */
const web = new Map<string, string | (() => Response)>();
const asked: string[] = [];
const websiteFetch = {
  fetchImpl: vi.fn(async (input: unknown) => {
    const url = String(input);
    asked.push(url);
    const answer = web.get(url);
    if (answer === undefined) return new Response('not found', { status: 404 });
    if (typeof answer === 'function') return answer();
    const type = url.endsWith('.xml') ? 'application/xml' : 'text/html; charset=utf-8';
    return new Response(answer, { status: 200, headers: { 'content-type': type } });
  }) as unknown as typeof fetch,
  lookup: async () => ['93.184.215.14'],
};
const pagesAsked = () => asked.filter((url) => !url.endsWith('.xml'));

// --- Telegram and X -------------------------------------------------------------

function telegramStack() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let messageId = 500;
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const method = String(input).split('/').pop()!;
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
  MAX_RETRY_ATTEMPTS: '2',
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
      websiteFetch,
      logger: createTestLogger(),
      sleep: instantSleep,
      skipLock: true,
      translationProvider: null,
      ...options,
    }),
  );
  return { summary, telegram };
}

async function followSite(url = SITEMAP) {
  const [source] = await db
    .insert(sources)
    .values({ workspaceId: DEFAULT_WORKSPACE_ID, platform: 'website', externalId: url, username: 'news.example.com' })
    .returning();
  return source!;
}

const reviews = (calls: { method: string; body: Record<string, unknown> }[]) =>
  calls.filter((call) => call.method === 'sendMessage' && call.body.reply_markup).length;

/** Followed, with these pages as its backlog, and nothing asked for yet. */
async function followedWith(slugs: string[]) {
  const source = await followSite();
  web.set(SITEMAP, sitemap(slugs));
  for (const slug of slugs) web.set(pageUrl(slug), article(slug));
  await sync();
  asked.length = 0;
  return source;
}

// --- The tests ------------------------------------------------------------------

describeIfDb('a website source in the sync', () => {
  it('records what the sitemap lists when followed — fetching no page, scoring and sending nothing', async () => {
    await followSite();
    web.set(SITEMAP, sitemap(['a', 'b', 'c']));
    const radar = fakeAnthropic(() => messageResponse(radarOutput({ score: 50 })));

    const { summary, telegram } = await sync(telegramStack(), {
      radarRun: createRadarRun({ promptVersions: [RADAR_PROMPT_BASELINE], provider: radar.provider }),
    });

    expect(asked).toEqual([SITEMAP]);
    expect(telegram.calls).toHaveLength(0);
    expect(radar.requests).toHaveLength(0);
    expect(summary.sources[0]).toMatchObject({ platform: 'website', checked: 3, skipped: 3, newPosts: 0 });
    const rows = await db.select().from(processedPosts);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.status === 'skipped' && row.errorMessage === RSS_BACKLOG_REASON)).toBe(true);
    expect(rows.map((row) => row.externalId).sort()).toEqual(['a', 'b', 'c'].map((slug) => webItemId(pageUrl(slug))).sort());
  });

  it('then fetches only the one new page, and sends its article for review', async () => {
    await followedWith(['a', 'b']);

    expect((await sync()).telegram.calls).toHaveLength(0);
    expect(pagesAsked()).toEqual([]);

    web.set(SITEMAP, sitemap(['a', 'b', 'c']));
    web.set(pageUrl('c'), article('c'));
    const { telegram } = await sync();

    expect(pagesAsked()).toEqual([pageUrl('c')]);
    expect(reviews(telegram.calls)).toBe(1);
    const [preview, control] = telegram.calls;
    expect(preview!.body.text).toBe(
      `Headline of c\n\nThe lead of c: what happened, said in a sentence that is long enough to stand as the summary.\n\n${pageUrl('c')}`,
    );
    expect(preview!.body.link_preview_options).toEqual({ url: pageUrl('c') });
    expect(control!.body.text).toContain(`Source: Example News\n${pageUrl('c')}`);

    const [row] = await db.select().from(processedPosts).where(eq(processedPosts.status, 'awaiting_approval'));
    expect(row).toMatchObject({ externalId: webItemId(pageUrl('c')), xAuthorUsername: 'Example News', xPostUrl: pageUrl('c') });
    expect(row!.sourceText).toMatch(/^Headline of c\n\nThe lead of c/);
    expect(row!.analysisText).toContain('Paragraph 5 of c');
    expect(row!.sourceMetadata).toMatchObject({ website: { sitemapUrl: SITEMAP, language: 'en' } });

    // Known now: never fetched again.
    asked.length = 0;
    await sync();
    expect(pagesAsked()).toEqual([]);
  });

  it('shows Radar the article’s whole text, and names the site as a website', async () => {
    await db.update(workspaces).set({ editorialProfile: 'Space science.' }).where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
    await followedWith(['a']);
    web.set(SITEMAP, sitemap(['a', 'b']));
    web.set(pageUrl('b'), article('b'));

    const radar = fakeAnthropic(() => messageResponse(radarOutput({ score: 71 })));
    await sync(telegramStack(), { radarRun: createRadarRun({ promptVersions: [RADAR_PROMPT_BASELINE], provider: radar.provider }) });

    const prompt = JSON.stringify(radar.requests[0]);
    expect(prompt).toContain('Example News (website)');
    expect(prompt).toContain('<article_text>');
    expect(prompt).toContain('Paragraph 5 of b');
    expect(await db.select().from(radarEvaluations)).toEqual([expect.objectContaining({ status: 'ok', score: 71 })]);
  });

  it('passes over a page that is no article, for good', async () => {
    await followedWith(['a']);
    web.set(SITEMAP, sitemap(['a', 'tag-page']));
    web.set(pageUrl('tag-page'), '<html><head><title>Tag: space</title></head><body><p>Nothing here.</p></body></html>');

    const { telegram } = await sync();
    expect(telegram.calls).toHaveLength(0);
    const [row] = await db.select().from(processedPosts).where(eq(processedPosts.externalId, webItemId(pageUrl('tag-page'))));
    expect(row).toMatchObject({ status: 'skipped' });
    expect(row!.errorMessage).toMatch(new RegExp(`^${WEBSITE_PAGE_REASON_PREFIX}not an article`));

    asked.length = 0;
    await sync();
    expect(pagesAsked()).toEqual([]);
  });

  it('tries a page that fails to load again on a later run, and gives up after a few', async () => {
    await followedWith(['a']);
    web.set(SITEMAP, sitemap(['a', 'flaky']));
    web.set(pageUrl('flaky'), () => new Response('busy', { status: 503 }));

    const first = await sync();
    expect(first.summary.sources[0]).toMatchObject({ failed: 1 });
    const id = webItemId(pageUrl('flaky'));
    expect((await db.select().from(processedPosts).where(eq(processedPosts.externalId, id)))[0]).toMatchObject({ status: 'failed', retryCount: 1 });

    // It comes back: taken as any new page.
    web.set(pageUrl('flaky'), article('flaky'));
    expect(reviews((await sync()).telegram.calls)).toBe(1);

    // Another that never loads: settled after MAX_RETRY_ATTEMPTS (2), then left alone.
    web.set(SITEMAP, sitemap(['a', 'flaky', 'dead']));
    web.set(pageUrl('dead'), () => new Response('blocked', { status: 403 }));
    await sync();
    await sync();
    const dead = (await db.select().from(processedPosts).where(eq(processedPosts.externalId, webItemId(pageUrl('dead')))))[0];
    expect(dead).toMatchObject({ status: 'skipped', retryCount: 2 });
    asked.length = 0;
    await sync();
    expect(pagesAsked()).toEqual([]);
  });

  it('takes no more than a run allows, oldest first, and the rest on the next run', async () => {
    await followedWith(['a']);
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    web.set(SITEMAP, sitemap(['a', { slug: 'new3', lastmod: at(1) }, { slug: 'new1', lastmod: at(30) }, { slug: 'new2', lastmod: at(20) }]));
    for (const slug of ['new1', 'new2', 'new3']) web.set(pageUrl(slug), article(slug));

    const first = await sync(telegramStack(), {}, { MAX_POSTS_PER_RUN: '2' });
    expect(reviews(first.telegram.calls)).toBe(2);
    expect(pagesAsked()).toEqual([pageUrl('new1'), pageUrl('new2')]);

    asked.length = 0;
    const second = await sync(telegramStack(), {}, { MAX_POSTS_PER_RUN: '2' });
    expect(reviews(second.telegram.calls)).toBe(1);
    expect(pagesAsked()).toEqual([pageUrl('new3')]);
  });

  it('stops for the run’s time budget, leaving new pages for the next run', async () => {
    await followedWith(['a']);
    web.set(SITEMAP, sitemap(['a', 'b']));
    web.set(pageUrl('b'), article('b'));

    // The time is up once the sitemap is read.
    const late = await sync(telegramStack(), { deadline: 5, now: () => (asked.includes(SITEMAP) ? 10 : 0) });
    expect(asked).toEqual([SITEMAP]);
    expect(late.telegram.calls).toHaveLength(0);
    expect(late.summary.sources[0]).toMatchObject({ stoppedForTime: true });

    expect(reviews((await sync()).telegram.calls)).toBe(1);
  });

  it('takes a page the sitemap dates from before the source as backlog, unfetched', async () => {
    await followedWith(['a']);
    web.set(SITEMAP, sitemap(['a', { slug: 'archive', lastmod: '2019-03-01' }]));
    web.set(pageUrl('archive'), article('archive', '2019-03-01T00:00:00Z'));

    const { telegram } = await sync();
    expect(pagesAsked()).toEqual([]);
    expect(telegram.calls).toHaveLength(0);
    const [row] = await db.select().from(processedPosts).where(eq(processedPosts.externalId, webItemId(pageUrl('archive'))));
    expect(row).toMatchObject({ status: 'skipped', errorMessage: RSS_BACKLOG_REASON });
  });

  it('passes over what the site published while the source was paused', async () => {
    const source = await followedWith(['a']);
    await setSourceEnabled(db, { id: source.id, enabled: false });
    web.set(SITEMAP, sitemap(['a', 'b', 'c']));
    for (const slug of ['b', 'c']) web.set(pageUrl(slug), article(slug));
    expect((await sync()).telegram.calls).toHaveLength(0);

    await setSourceEnabled(db, { id: source.id, enabled: true });
    const resumed = await sync();
    expect(resumed.telegram.calls).toHaveLength(0);
    expect(pagesAsked()).toEqual([]);

    web.set(SITEMAP, sitemap(['a', 'b', 'c', 'd']));
    web.set(pageUrl('d'), article('d'));
    expect(reviews((await sync()).telegram.calls)).toBe(1);
  });

  it('does not let a broken website stop a feed', async () => {
    await followSite();
    web.set(SITEMAP, () => new Response('down', { status: 500 }));
    await db.insert(sources).values({ platform: 'rss', externalId: FEED_URL, username: 'ESA Space Science' });
    const feed = (items: number[]) =>
      `<?xml version="1.0"?><rss version="2.0"><channel><title>ESA Space Science</title>${items
        .map((n) => `<item><title>Story ${n}</title><link>https://www.esa.int/${n}</link><guid>esa-${n}</guid><description>About story ${n}.</description></item>`)
        .join('')}</channel></rss>`;
    const feeds = new Map([[FEED_URL, feed([1])]]);
    const feedFetch = {
      fetchImpl: vi.fn(async (input: unknown) => new Response(feeds.get(String(input)) ?? '', { status: 200 })) as unknown as typeof fetch,
      lookup: async () => ['93.184.215.14'],
    };
    await sync(telegramStack(), { feedFetch });
    feeds.set(FEED_URL, feed([2, 1]));

    const { summary, telegram } = await sync(telegramStack(), { feedFetch });
    expect(reviews(telegram.calls)).toBe(1);
    const site = summary.sources.find((entry) => entry.platform === 'website');
    expect(site?.error).toMatch(/server error \(500\)/);
  });

  it('shows in source stats without its backlog or the pages that were no article', async () => {
    const source = await followedWith(['a', 'b']);
    web.set(SITEMAP, sitemap(['a', 'b', 'c', 'not-article']));
    web.set(pageUrl('c'), article('c'));
    web.set(pageUrl('not-article'), '<html><head><title>x</title></head><body>x</body></html>');
    await sync();

    const [stats] = await loadSourceStats(db, { workspaceIds: [DEFAULT_WORKSPACE_ID], since: null });
    expect(stats).toMatchObject({
      sourceId: source.id,
      platform: 'website',
      label: 'news.example.com',
      feedUrl: SITEMAP,
      posts: 1,
      waiting: 1,
      notSent: 0,
      readCostUsd: null,
    });
  });
});

describeIfDb('/addwebsite', () => {
  const context = () => ({
    db,
    xClient: unusedX(),
    logger: createTestLogger(),
    workspaceId: DEFAULT_WORKSPACE_ID,
    workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: 'first' }],
    websiteFetch,
  });
  const addwebsite = (args: string) => dispatchCommand(context(), { command: 'addwebsite', args });
  const siteSources = () => db.select().from(sources).where(eq(sources.platform, 'website'));

  it('adds a sitemap index under the site’s host, counting what it lists, fetching no page', async () => {
    const index = 'https://www.news.example.com/sitemap_index.xml';
    web.set(
      index,
      '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
        '<sitemap><loc>https://www.news.example.com/posts.xml</loc></sitemap><sitemap><loc>https://www.news.example.com/pages.xml</loc></sitemap></sitemapindex>',
    );
    web.set('https://www.news.example.com/posts.xml', sitemap(['a', 'b', 'c']));
    web.set('https://www.news.example.com/pages.xml', sitemap(['about']));

    const reply = await addwebsite(`${index}#x`);

    expect(reply?.text).toContain('Website added');
    expect(reply?.text).toContain('2 sitemaps · 4 URLs');
    expect(pagesAsked()).toEqual([]);
    expect(await siteSources()).toEqual([expect.objectContaining({ externalId: index, username: 'news.example.com' })]);
  });

  it('turns away an address that is no sitemap, or a private one, storing nothing', async () => {
    web.set('https://news.example.com/', '<html><body>Home</body></html>');
    expect((await addwebsite('https://news.example.com/'))?.text).toContain(NOT_A_SITEMAP.replace('<', '&lt;').replace('>', '&gt;').slice(0, 30));
    expect((await addwebsite('http://169.254.169.254/latest/meta-data'))?.text).toContain('not allowed');
    expect(await siteSources()).toEqual([]);
  });
});
