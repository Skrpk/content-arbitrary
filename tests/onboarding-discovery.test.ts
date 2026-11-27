import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@/lib/logger';
import { registrableDomain } from '@/lib/onboarding/candidates';
import { discoverSources, outletStems, pick, scoreOf, type CheckedCandidate } from '@/lib/onboarding/discover-sources';
import { historySignals, namedLike, strongEnough, type HistoryItemSignal } from '@/lib/onboarding/link-signals';
import { discoverSiteFeed } from '@/lib/onboarding/site-feed';
import { suggestionToCandidate, type SourceDiscoverer } from '@/lib/onboarding/source-discovery';
import { channelPage } from './channel-page-fakes';

/**
 * Finding an onboarded channel's sources: what its history points at, what a
 * search suggests, how a website is followed, and which five are picked.
 */

const logger = createLogger({ app: 'test' });
const publicHost = async () => ['93.184.216.34'];

const post = (links: string[] = [], extra: Partial<HistoryItemSignal> & { forwardedFrom?: string } = {}): HistoryItemSignal => ({
  text: extra.text ?? 'A post',
  metadata: {
    ...(links.length > 0 ? { outboundLinks: links.map((url) => ({ url })) } : {}),
    ...(extra.forwardedFrom ? { forwarded: true, forwardedFrom: extra.forwardedFrom } : {}),
  },
});

describe('what a channel’s history points at', () => {
  it('counts forwards and links, once per post, and leaves out noise, the channel itself and its own site', () => {
    const items: HistoryItemSignal[] = [
      post(['https://www.ownsite.com.ua/a', 'https://blog.playstation.com/x', 'https://blog.playstation.com/y']),
      post(['https://ownsite.com.ua/b', 'https://blog.playstation.com/z', 'https://t.me/gamingnews_ua/5']),
      post(['https://ownsite.com.ua/c', 'https://t.me/GamingNews_UA', 'https://t.me/ownsite_news/3', 'https://x.com/someone/status/1']),
      post(['https://ownsite.com.ua/d'], { forwardedFrom: 'vgc_news' }),
      post(['https://vgc.com/a', 'https://ownsite.com.ua/e'], { forwardedFrom: 'VGC_news' }),
      post(['https://aliexpress.com/item/1', 'https://bit.ly/abc', 'https://facebook.com/page']),
      post(['https://aliexpress.com/item/2', 'https://shop.example.org/x'], { text: 'Знижки! #реклама' }),
      post(['https://www.youtube.com/watch?v=abcdefghijk', 'https://youtu.be/abcdefghijk']),
      post(['https://youtu.be/abcdefghijk', 'https://www.youtube.com/@PlayStation']),
      post(['https://www.youtube.com/@PlayStation/videos']),
    ];
    const signals = historySignals(items, { username: 'ownsite_news' });

    expect(signals.ownSite).toBe('ownsite.com.ua');
    expect(signals.adPostsSkipped).toBe(1);
    expect(signals.xLinks).toBe(1);
    expect(signals.youtubeVideos).toEqual(new Map([['abcdefghijk', 2]]));
    const byKey = Object.fromEntries(signals.candidates.map((candidate) => [candidate.key, candidate]));
    expect(Object.keys(byKey).sort()).toEqual(['site:playstation.com', 'site:vgc.com', 'telegram:gamingnews_ua', 'telegram:vgc_news', 'youtube:@PlayStation']);
    expect(byKey['site:playstation.com']).toMatchObject({ links: 2, forwards: 0, origin: 'history_link', target: 'https://blog.playstation.com/' });
    expect(byKey['telegram:vgc_news']).toMatchObject({ forwards: 2, links: 0, origin: 'history_forward' });
    expect(byKey['telegram:gamingnews_ua']).toMatchObject({ links: 2 });

    expect(strongEnough(signals.candidates).map((candidate) => candidate.key).sort()).toEqual([
      'site:playstation.com',
      'telegram:gamingnews_ua',
      'telegram:vgc_news',
      'youtube:@PlayStation',
    ]);
  });

  it('takes a site for the channel’s own by its name, not by how often it is linked', () => {
    const links = [
      ...Array.from({ length: 6 }, () => post(['https://www.ign.com/articles/x'])),
      ...Array.from({ length: 2 }, () => post(['https://blog.playstation.com/x'])),
      post(),
      post(),
    ];
    const signals = historySignals(links, { username: 'playstationua' });
    expect(signals.ownSite).toBeNull();
    expect(signals.candidates.map((candidate) => candidate.key)).toEqual(['site:ign.com', 'site:playstation.com']);
    expect(namedLike('pravda.com.ua', 'ukrpravda_news')).toBe(true);
    expect(namedLike('tsn.ua', 'tsn_ua')).toBe(true);
    expect(namedLike('ign.com', 'playstationua')).toBe(false);
  });

  it('knows a site by its registrable domain', () => {
    expect(registrableDomain('news.pravda.com.ua')).toBe('pravda.com.ua');
    expect(registrableDomain('blog.playstation.com')).toBe('playstation.com');
    expect(registrableDomain('bbc.co.uk')).toBe('bbc.co.uk');
  });
});

describe('a search’s suggestion', () => {
  const suggestion = (platform: 'telegram' | 'youtube' | 'website', url: string) => ({
    name: 'Name',
    platform,
    url,
    organization: 'Org',
    kind: 'official' as const,
    reason: 'Why',
  });

  it('becomes a candidate keyed like the history’s, or nothing for what cannot be followed', () => {
    expect(suggestionToCandidate(suggestion('telegram', 'https://t.me/VGC_news'))).toMatchObject({ key: 'telegram:vgc_news', target: 'vgc_news', origin: 'discovery' });
    expect(suggestionToCandidate(suggestion('youtube', 'https://www.youtube.com/@PlayStation'))).toMatchObject({ key: 'youtube:@PlayStation' });
    expect(suggestionToCandidate(suggestion('website', 'https://www.blog.playstation.com/news'))).toMatchObject({
      key: 'site:playstation.com',
      target: 'https://www.blog.playstation.com/',
      organization: 'org',
    });
    expect(suggestionToCandidate(suggestion('youtube', 'https://youtu.be/abcdefghijk'))).toBeNull();
    expect(suggestionToCandidate(suggestion('website', 'https://facebook.com/ps'))).toBeNull();
    expect(suggestionToCandidate(suggestion('telegram', 'https://t.me/+invite'))).toBeNull();
  });
});

function checked(
  key: string,
  platform: CheckedCandidate['source']['platform'],
  externalId: string,
  extra: Partial<CheckedCandidate> = {},
): CheckedCandidate {
  const candidate = {
    key,
    platform: platform === 'rss' ? 'website' : platform,
    target: externalId,
    name: key,
    origin: 'history_link',
    links: 0,
    forwards: 0,
    reason: null,
    kind: null,
    organization: null,
    source: { platform, externalId, username: key },
    via: null,
    ...extra,
  } as CheckedCandidate;
  return { ...candidate, score: scoreOf(candidate) };
}

describe('picking five', () => {
  it('puts what the channel forwards and links first, then primary sources, with variety', () => {
    const ranked = [
      checked('telegram:a', 'telegram', 'a_news', { forwards: 6 }),
      checked('telegram:b', 'telegram', 'b_channel', { links: 5 }),
      checked('telegram:c', 'telegram', 'c_more', { links: 4 }),
      checked('site:a', 'rss', 'https://a.com.ua/rss', { links: 3, organization: 'a.com.ua' }),
      checked('site:x', 'rss', 'https://x.org/feed', { origin: 'discovery', kind: 'official', organization: 'x' }),
      checked('site:y', 'website', 'https://y.org/sitemap.xml', { origin: 'discovery', kind: 'specialist', organization: 'x' }),
      checked('youtube:z', 'youtube', 'UCzzzzzzzzzzzzzzzzzzzzzz', { origin: 'discovery', kind: 'creator' }),
    ].sort((a, b) => b.score - a.score);

    const chosen = pick(ranked).map((candidate) => candidate.key);
    // At most two Telegram channels, one per organisation, the same outlet once; a search's find is in.
    expect(chosen).toEqual(['telegram:a', 'telegram:b', 'site:a', 'site:x', 'youtube:z']);
  });

  it('fills five when variety alone would leave fewer', () => {
    const ranked = ['a', 'b', 'c', 'd', 'e', 'f'].map((name, index) => checked(`telegram:${name}`, 'telegram', `${name}chan${name}`, { links: 10 - index }));
    expect(pick(ranked)).toHaveLength(5);
  });

  it('tells the same outlet on two platforms by its name', () => {
    expect([...outletStems(checked('t', 'telegram', 'epravda'))]).toEqual(['epravda']);
    expect([...outletStems(checked('s', 'rss', 'https://epravda.com.ua/rss'))]).toContain('epravda');
    expect([...outletStems(checked('t', 'telegram', 'oboronka1'))]).toEqual(['oboronka']);
    expect([...outletStems(checked('s', 'rss', 'https://oboronka.mezha.ua/feed'))]).toContain('oboronka');
  });
});

/** Sites, robots.txt and feeds, by URL; anything else is a 404. */
function fakeWeb(pages: Record<string, { body: string; type?: string } | (() => Response)>) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    const page = pages[url];
    if (typeof page === 'function') return page();
    if (!page) return new Response('not found', { status: 404 });
    return new Response(page.body, { status: 200, headers: { 'content-type': page.type ?? 'text/html' } });
  }) as unknown as typeof fetch;
}

const RSS = (title: string) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><item><title>One</title><link>https://example.org/1</link><guid>1</guid></item></channel></rss>`;
const URLSET = (count: number, base = 'https://site.example') =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Array.from({ length: count }, (_, i) => `<url><loc>${base}/a/${i}</loc></url>`).join('')}</urlset>`;

describe('following a website', () => {
  it('takes the feed its home page announces', async () => {
    const feed = await discoverSiteFeed('https://site.example/', {
      lookup: publicHost,
      fetchImpl: fakeWeb({
        'https://site.example/': {
          body:
            '<html><head><link rel="alternate" type="application/rss+xml" href="https://cz.site.example/feed">' +
            '<link rel="alternate" type="application/rss+xml" href="/news/rss"></head></html>',
        },
        'https://cz.site.example/feed': { body: RSS('Czech edition'), type: 'application/rss+xml' },
        'https://site.example/news/rss': { body: RSS('Site News'), type: 'application/rss+xml' },
      }),
    });
    expect(feed).toEqual({ kind: 'rss', source: { platform: 'rss', externalId: 'https://site.example/news/rss', username: 'Site News' } });
  });

  it('tries the usual feed paths, then a news sitemap, and skips a sitemap of the whole site', async () => {
    const atPath = await discoverSiteFeed('https://site.example/', {
      lookup: publicHost,
      fetchImpl: fakeWeb({ 'https://site.example/': { body: '<html></html>' }, 'https://site.example/rss.xml': { body: RSS('Paths'), type: 'application/xml' } }),
    });
    expect(atPath).toMatchObject({ kind: 'rss', source: { externalId: 'https://site.example/rss.xml' } });

    const news = await discoverSiteFeed('https://site.example/', {
      lookup: publicHost,
      fetchImpl: fakeWeb({
        'https://site.example/robots.txt': { body: 'User-agent: *\nSitemap: https://site.example/sitemap-news.xml\nSitemap: https://site.example/all.xml', type: 'text/plain' },
        'https://site.example/sitemap-news.xml': { body: URLSET(3), type: 'application/xml' },
      }),
    });
    expect(news).toMatchObject({ kind: 'news_sitemap', source: { platform: 'website', externalId: 'https://site.example/sitemap-news.xml' } });

    const huge = await discoverSiteFeed('https://site.example/', {
      lookup: publicHost,
      fetchImpl: fakeWeb({ 'https://site.example/sitemap.xml': { body: URLSET(10_000), type: 'application/xml' } }),
    });
    expect(huge).toBeNull();
  });

  it('never reaches a private address', async () => {
    const fetchImpl = fakeWeb({});
    const feed = await discoverSiteFeed('http://intranet.local/', { lookup: async () => ['10.0.0.5'], fetchImpl });
    expect(feed).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('discovering a channel’s sources', () => {
  it('checks the history’s and the search’s candidates, and picks from those that resolve', async () => {
    const history = [
      post([], { forwardedFrom: 'vgc_news' }),
      post([], { forwardedFrom: 'vgc_news' }),
      post(['https://t.me/dead_channel']),
      post(['https://t.me/dead_channel']),
    ];
    const discoverer: SourceDiscoverer = {
      model: 'fake',
      discover: vi.fn(async () => ({
        suggestions: [
          { name: 'PlayStation Blog', platform: 'website' as const, url: 'https://blog.playstation.com', organization: 'Sony', kind: 'official' as const, reason: 'Офіційні анонси.' },
          { name: 'Nowhere', platform: 'website' as const, url: 'https://nowhere.example', organization: 'Nobody', kind: 'specialist' as const, reason: 'x' },
        ],
        webSearches: 2,
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    };
    const fetchImpl = fakeWeb({
      'https://t.me/s/vgc_news': { body: channelPage([{ id: 1, text: 'News' }], 'VGC', 'vgc_news') },
      'https://blog.playstation.com/': { body: '<link rel="alternate" type="application/atom+xml" href="https://blog.playstation.com/feed">' },
      'https://blog.playstation.com/feed': { body: RSS('PlayStation.Blog'), type: 'application/rss+xml' },
      'https://t.me/s/dead_channel': () => new Response('', { status: 302, headers: { location: 'https://telegram.org' } }),
    });

    const result = await discoverSources(
      { channel: { username: 'spacenews', title: 'Space News', language: 'uk', editorialProfile: 'Ігри.', topics: ['ігри'] }, history },
      { youtube: null, discoverer, logger, fetchImpl, lookup: publicHost },
    );

    expect(result.picked.map((candidate) => [candidate.key, candidate.origin, candidate.source.platform])).toEqual([
      ['telegram:vgc_news', 'history_forward', 'telegram'],
      ['site:playstation.com', 'discovery', 'rss'],
    ]);
    expect(result.picked[1]).toMatchObject({ name: 'PlayStation Blog', reason: 'Офіційні анонси.', via: 'rss' });
    expect(result.failed.map((failure) => failure.key).sort()).toEqual(['site:nowhere.example', 'telegram:dead_channel']);
    expect(result.stats).toMatchObject({ fromHistory: 2, fromSearch: 2, webSearches: 2, searchError: null });
    expect(vi.mocked(discoverer.discover).mock.calls[0]![0]).toMatchObject({
      known: [{ name: '@vgc_news', evidence: 'forwarded 2 times' }, { name: '@dead_channel', evidence: 'linked 2 times' }],
      exclude: ['https://t.me/spacenews'],
    });
  });

  it('goes on with the history alone when the search fails', async () => {
    const result = await discoverSources(
      { channel: { username: 'spacenews', title: 'Space News', language: null, editorialProfile: null, topics: [] }, history: [post([], { forwardedFrom: 'vgc_news' }), post([], { forwardedFrom: 'vgc_news' })] },
      {
        youtube: null,
        discoverer: { model: 'fake', discover: async () => { throw new Error('search timed out'); } },
        logger,
        fetchImpl: fakeWeb({ 'https://t.me/s/vgc_news': { body: channelPage([{ id: 1, text: 'News' }], 'VGC', 'vgc_news') } }),
        lookup: publicHost,
      },
    );
    expect(result.picked.map((candidate) => candidate.key)).toEqual(['telegram:vgc_news']);
    expect(result.stats.searchError).toMatch(/search timed out/);
  });
});
