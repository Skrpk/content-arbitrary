import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FeedError } from '@/lib/errors';
import { fetchFeed } from '@/lib/rss/client';
import { entryStableKey, rssItemId } from '@/lib/rss/identity';
import { entryText, entryToPost, oldestFirst, RSS_TEXT_MAX } from '@/lib/rss/normalize';
import { parseFeed } from '@/lib/rss/parser';
import { htmlToText } from '@/lib/rss/text';
import { assertFetchable, isPrivateAddress, normalizeFeedUrl } from '@/lib/rss/url';
import { formatSourceLabel, isRssItemId, sourceLabelOfPost } from '@/lib/sources/display';
import { formatTextPost } from '@/lib/telegram/format-caption';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'rss', name), 'utf8');
const FEED = 'https://feeds.example/feed.xml';

describe('parsing a feed', () => {
  it('reads RSS 2.0', () => {
    const feed = parseFeed(fixture('rss2.xml'), FEED);

    expect(feed).toMatchObject({
      format: 'rss2',
      title: 'ESA Space Science',
      siteUrl: 'https://www.esa.int/Science_Exploration/Space_Science',
      feedUrl: FEED,
    });
    expect(feed.entries).toHaveLength(3);
    expect(feed.entries[0]).toEqual({
      stableId: 'guid:esa-2026-0003',
      url: 'https://www.esa.int/juice-venus',
      title: 'Juice swings past Venus',
      summary: "ESA's Jupiter probe used Venus's gravity to bend its path towards the outer Solar System.",
      content: null,
      author: 'ESA',
      publishedAt: new Date('2026-10-07T09:00:00Z'),
      updatedAt: null,
    });
  });

  it('reads Atom 1.0, taking the alternate link and the entry id', () => {
    const feed = parseFeed(fixture('atom.xml'), FEED);

    expect(feed).toMatchObject({ format: 'atom', title: 'JPL News', siteUrl: 'https://www.jpl.nasa.gov/news' });
    expect(feed.entries[0]).toMatchObject({
      stableId: 'id:tag:jpl.nasa.gov,2026:news/1002',
      url: 'https://www.jpl.nasa.gov/news/perseverance-layers',
      author: 'JPL',
      publishedAt: new Date('2026-10-07T10:00:00Z'),
      updatedAt: new Date('2026-10-07T11:00:00Z'),
    });
    // No published date: it has only updated.
    expect(feed.entries[1]).toMatchObject({ publishedAt: null, updatedAt: new Date('2026-10-06T15:00:00Z') });
  });

  it('takes HTML in CDATA apart, dropping navigation and scripts', () => {
    const [entry] = parseFeed(fixture('rss-cdata.xml'), FEED).entries;

    expect(entryText(entry!)).toBe(
      'Starship reaches orbit\n\nStarship reaches orbit — the test went as planned.\nEngineers will now study the data.\nMore soon.',
    );
  });

  it('reads Atom HTML titles and inline xhtml content in order, and resolves a relative link', () => {
    const feed = parseFeed(fixture('atom-html.xml'), FEED);
    const [entry] = feed.entries;

    expect(feed.title).toBe('Astro & Cosmos');
    expect(entry!.title).toBe('Webb & the first galaxies');
    expect(entry!.url).toBe('https://feeds.example/posts/webb-first-galaxies');
    // The summary says too little, so the content stands in for it.
    expect(entryText(entry!)).toBe(
      'Webb & the first galaxies\n\nThe telescope has found galaxies from the first 300 million years after the Big Bang.',
    );
  });

  it('decodes entities and keeps Unicode and emoji', () => {
    const feed = parseFeed(fixture('entities.xml'), FEED);

    expect(feed.title).toBe('Космос & наука 🚀');
    expect(entryText(feed.entries[0]!)).toBe(
      'Марс — новий знімок 🔭\n\nРовер Perseverance надіслав «кольоровий» знімок…\nДруга частина.',
    );
  });

  it('reads an empty feed as no entries', () => {
    expect(parseFeed(fixture('empty.xml'), FEED).entries).toEqual([]);
  });

  it('refuses XML that is not well-formed, and XML that is not a feed', () => {
    const malformed = () => parseFeed(fixture('malformed.xml'), FEED);
    expect(malformed).toThrow(FeedError);
    expect(malformed).toThrow(/Not well-formed XML/);

    expect(() => parseFeed('<html><body>Hello</body></html>', FEED)).toThrow(/Not an RSS 2.0 or Atom feed/);
  });

  it('never expands an entity a DOCTYPE defines', () => {
    const bomb =
      '<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY a "AAAAAAAAAA"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]>' +
      '<rss version="2.0"><channel><title>T</title><item><title>&b;</title><guid>1</guid></item></channel></rss>';

    const [entry] = parseFeed(bomb, FEED).entries;
    expect(entry!.title).toBe('&b;');
  });
});

describe('who an entry is', () => {
  it('prefers the Atom id, then the guid, then the link, then a hash', () => {
    expect(entryStableKey({ atomId: 'tag:1', guid: 'g', link: 'https://a' })).toBe('id:tag:1');
    expect(entryStableKey({ guid: 'g', link: 'https://a' })).toBe('guid:g');
    expect(entryStableKey({ link: 'https://a' })).toBe('link:https://a');
    expect(entryStableKey({ title: 'T', text: 'words' })).toMatch(/^hash:[0-9a-f]{64}$/);
  });

  it('falls back to the link, or to a hash that is the same every time', () => {
    const once = parseFeed(fixture('rss-no-guid.xml'), FEED).entries;
    const again = parseFeed(fixture('rss-no-guid.xml'), FEED).entries;

    expect(once[0]!.stableId).toBe('link:https://linkonly.example/a?id=1&lang=en');
    expect(once[1]!.stableId).toMatch(/^hash:/);
    expect(again.map((entry) => entry.stableId)).toEqual(once.map((entry) => entry.stableId));
  });

  it('stays the same when the title is edited under the same guid', () => {
    const xml = fixture('rss2.xml');
    const edited = xml.replace('Juice swings past Venus', 'Juice swings by Venus, on its way to Jupiter');

    expect(parseFeed(edited, FEED).entries[0]!.stableId).toBe(parseFeed(xml, FEED).entries[0]!.stableId);
  });

  it('does not depend on where the entry sits in the feed', () => {
    const xml = fixture('rss2.xml');
    const items = xml.match(/<item>[\s\S]*?<\/item>/g)!;
    const reordered = xml.replace(items.join('\n    '), [...items].reverse().join('\n    '));

    const ids = (text: string) =>
      parseFeed(text, FEED)
        .entries.map((entry) => rssItemId(FEED, entry.stableId))
        .sort();
    expect(ids(reordered)).toEqual(ids(xml));
  });

  it('is namespaced by feed, so two feeds never collide, nor do they with X', () => {
    const a = rssItemId('https://a.example/feed', 'guid:1');
    const b = rssItemId('https://b.example/feed', 'guid:1');

    expect(a).not.toBe(b);
    expect(a).toMatch(/^rss:[0-9a-f]{16}:[0-9a-f]{32}$/);
    expect(isRssItemId(a)).toBe(true);
    expect(isRssItemId('1750000000000000001')).toBe(false);
  });
});

describe('an entry as a candidate post', () => {
  const [entry] = parseFeed(fixture('rss2.xml'), FEED).entries;

  it('is a text post with the article apart from the text', () => {
    const post = entryToPost(entry!, { feedUrl: FEED, displayName: 'ESA Space Science' });

    expect(post).toEqual({
      platform: 'rss',
      id: rssItemId(FEED, 'guid:esa-2026-0003'),
      url: 'https://www.esa.int/juice-venus',
      authorUsername: 'ESA Space Science',
      createdAt: new Date('2026-10-07T09:00:00Z'),
      text: "Juice swings past Venus\n\nESA's Jupiter probe used Venus's gravity to bend its path towards the outer Solar System.",
      media: [],
      isReply: false,
      isRepost: false,
      isQuote: false,
      metrics: null,
    });
  });

  it('links nowhere rather than to an invented URL', () => {
    const [, wordsOnly] = parseFeed(fixture('rss-no-guid.xml'), FEED).entries;
    expect(entryToPost(wordsOnly!, { feedUrl: FEED, displayName: 'Link Only' }).url).toBe('');
  });

  it('says the title once when the description repeats it as its own line', () => {
    expect(entryText({ title: 'Big news', summary: '<p>Big news</p><p>Details follow here.</p>', content: null })).toBe(
      'Big news\n\nDetails follow here.',
    );
  });

  it('is capped, so a whole article body never reaches Radar', () => {
    const text = entryText({ title: 'Long', summary: null, content: `<p>${'word '.repeat(5000)}</p>` });
    expect(text.length).toBeLessThanOrEqual(RSS_TEXT_MAX);
    expect(text.endsWith('…')).toBe(true);
  });

  it('goes oldest first, keeping undated entries in the feed order, reversed', () => {
    const post = (id: string, at: string | null) =>
      ({ id, createdAt: at ? new Date(at) : null }) as Parameters<typeof oldestFirst>[0][number];

    expect(
      oldestFirst([post('c', '2026-10-03'), post('a', '2026-10-01'), post('b', '2026-10-02')]).map((p) => p.id),
    ).toEqual(['a', 'b', 'c']);
    expect(oldestFirst([post('new', null), post('old', null)]).map((p) => p.id)).toEqual(['old', 'new']);
  });

  it('is published with the article link at the end, before the footer', () => {
    const text = formatTextPost({
      text: 'Юпітер',
      username: 'ESA Space Science',
      postId: 'rss:x:y',
      includeSourceLink: true,
      sourceLine: 'https://www.esa.int/juice-venus',
    });
    expect(text).toBe('Юпітер\n\nhttps://www.esa.int/juice-venus');
  });
});

describe('HTML to text', () => {
  it('keeps paragraphs, drops markup, decodes entities, folds whitespace', () => {
    expect(htmlToText('<p>One&nbsp;&amp; <b>two</b>,</p>\n\n\n<p>  three   four </p><ul><li>a</li>\n<li>b</li></ul>')).toBe(
      'One & two,\n\nthree four\n• a\n• b',
    );
  });

  it('leaves plain text alone but for whitespace', () => {
    expect(htmlToText('  Just   text  ')).toBe('Just text');
  });
});

describe('names of sources', () => {
  it('puts an @ before an X handle and never before a feed', () => {
    expect(formatSourceLabel('x', 'NASA')).toBe('@NASA');
    expect(formatSourceLabel('rss', 'NASA News')).toBe('NASA News');
    expect(sourceLabelOfPost('rss:abc:def', 'NASA News')).toBe('NASA News');
    expect(sourceLabelOfPost('1750000000000000001', 'NASA')).toBe('@NASA');
    expect(sourceLabelOfPost('1', null)).toBeNull();
  });
});

describe('which feed URLs may be fetched', () => {
  it('normalises the URL conservatively', () => {
    expect(normalizeFeedUrl('  https://WWW.Example.com/feed.xml?lang=en#top  ')).toEqual({
      ok: true,
      url: 'https://www.example.com/feed.xml?lang=en',
    });
  });

  it.each([
    ['file:///etc/passwd', /http and https/],
    ['ftp://example.com/feed', /http and https/],
    ['javascript:alert(1)', /http and https/],
    ['data:text/xml,<rss/>', /http and https/],
    ['https://user:pass@example.com/feed', /username or password/],
    ['http://localhost:3000/feed', /Local/],
    ['http://app.localhost/feed', /Local/],
    ['http://127.0.0.1/feed', /Private/],
    ['http://169.254.169.254/latest/meta-data/', /Private/],
    ['http://10.1.2.3/feed', /Private/],
    ['http://172.20.0.1/feed', /Private/],
    ['http://192.168.1.1/feed', /Private/],
    ['http://[::1]/feed', /Private/],
    ['not a url', /not a URL/],
  ])('refuses %s', (input, reason) => {
    const result = normalizeFeedUrl(input);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(reason);
  });

  it('knows private addresses in IPv4 and IPv6, mapped forms included', () => {
    for (const address of ['10.0.0.1', '172.31.255.255', '100.64.0.1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1']) {
      expect(isPrivateAddress(address)).toBe(true);
    }
    for (const address of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });

  it('refuses a public-looking name that resolves to a private address', async () => {
    await expect(
      assertFetchable(new URL('https://sneaky.example/feed'), async () => ['10.0.0.5']),
    ).rejects.toThrow(/private or local/);
    await expect(
      assertFetchable(new URL('https://fine.example/feed'), async () => ['93.184.215.14']),
    ).resolves.toBeUndefined();
  });
});

describe('fetching a feed', () => {
  const publicLookup = async () => ['93.184.215.14'];
  const respond = (handler: (url: string) => Response) =>
    vi.fn(async (input: unknown) => handler(String(input))) as unknown as typeof fetch;

  it('returns the XML, following a redirect to a public host', async () => {
    const fetchImpl = respond((url) =>
      url === FEED
        ? new Response(null, { status: 301, headers: { location: 'https://cdn.feeds.example/feed.xml' } })
        : new Response(fixture('rss2.xml'), { status: 200 }),
    );

    const fetched = await fetchFeed(FEED, { fetchImpl, lookup: publicLookup });
    expect(fetched.finalUrl).toBe('https://cdn.feeds.example/feed.xml');
    expect(fetched.xml).toContain('ESA Space Science');
  });

  it('refuses a redirect to a private address before following it', async () => {
    const fetchImpl = respond(() => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }));

    await expect(fetchFeed(FEED, { fetchImpl, lookup: publicLookup })).rejects.toThrow(/Private/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops reading a feed larger than the limit', async () => {
    const fetchImpl = respond(() => new Response('x'.repeat(2000), { status: 200 }));

    await expect(fetchFeed(FEED, { fetchImpl, lookup: publicLookup, maxBytes: 1000 })).rejects.toMatchObject({
      code: 'feed_too_large',
      transient: false,
    });
  });

  it.each([
    [404, false, 'feed_not_found'],
    [410, false, 'feed_not_found'],
    [403, false, 'feed_http_error'],
    [429, true, 'feed_rate_limited'],
    [503, true, 'feed_server_error'],
  ])('reports HTTP %i as transient=%s', async (status, transient, code) => {
    const fetchImpl = respond(() => new Response('nope', { status }));

    await expect(fetchFeed(FEED, { fetchImpl, lookup: publicLookup })).rejects.toMatchObject({ transient, code });
  });

  it('gives up on a feed that does not answer in time', async () => {
    const fetchImpl = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)),
        ),
    ) as unknown as typeof fetch;

    await expect(fetchFeed(FEED, { fetchImpl, lookup: publicLookup, timeoutMs: 20 })).rejects.toMatchObject({
      code: 'feed_timeout',
      transient: true,
    });
  });
});
