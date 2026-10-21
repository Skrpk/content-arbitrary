import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { WebsiteError } from '@/lib/errors';
import { fetchPublic } from '@/lib/website/http';
import {
  fetchSitemap,
  MAX_SITEMAP_DEPTH,
  readSitemapTree,
  SITEMAP_MAX_BYTES,
  SITEMAP_MAX_UNCOMPRESSED_BYTES,
} from '@/lib/website/sitemap';
import { parseSitemap } from '@/lib/website/sitemap-parser';
import { normalizeWebsiteUrl, sameSite, webItemId } from '@/lib/website/url';

/**
 * A website's sitemaps: parsing them safely, walking an index within bounds,
 * and never fetching anything a sitemap should not lead to.
 */

const ROOT = 'https://news.example.com/sitemap.xml';

const urlset = (urls: { loc: string; lastmod?: string }[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
    .map((url) => `<url><loc>${url.loc}</loc>${url.lastmod ? `<lastmod>${url.lastmod}</lastmod>` : ''}</url>`)
    .join('')}</urlset>`;

const index = (locs: string[]) =>
  `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`)
    .join('')}</sitemapindex>`;

/** A fetch answering from a table of URLs; anything else is a 404. Every URL asked for is recorded. */
function site(pages: Record<string, string | Uint8Array | (() => Response)>) {
  const asked: string[] = [];
  const fetchImpl = vi.fn(async (input: unknown) => {
    const url = String(input);
    asked.push(url);
    const answer = pages[url];
    if (answer === undefined) return new Response('not found', { status: 404 });
    if (typeof answer === 'function') return answer();
    return new Response(answer as BodyInit, { status: 200, headers: { 'content-type': 'application/xml' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, lookup: async () => ['93.184.215.14'], asked };
}

describe('a sitemap, parsed', () => {
  it('lists a urlset’s pages with their lastmod, in any namespace prefix, entities decoded', () => {
    const parsed = parseSitemap(
      '<?xml version="1.0"?><s:urlset xmlns:s="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">' +
        '<s:url><s:loc>https://e.com/a?x=1&amp;y=2</s:loc><s:lastmod>2026-10-20</s:lastmod></s:url>' +
        '<s:url><s:loc>https://e.com/b</s:loc><news:news><news:publication_date>2026-10-19T10:00:00Z</news:publication_date></news:news></s:url>' +
        '</s:urlset>',
    );
    expect(parsed).toEqual({
      kind: 'urlset',
      urls: [
        { loc: 'https://e.com/a?x=1&y=2', lastmod: new Date('2026-10-20T00:00:00Z'), published: null },
        { loc: 'https://e.com/b', lastmod: null, published: new Date('2026-10-19T10:00:00Z') },
      ],
    });
  });

  it('lists an index’s sitemaps', () => {
    expect(parseSitemap(index(['https://e.com/1.xml', 'https://e.com/2.xml']))).toMatchObject({
      kind: 'index',
      sitemaps: [{ loc: 'https://e.com/1.xml' }, { loc: 'https://e.com/2.xml' }],
    });
  });

  it('refuses malformed XML, and XML that is no sitemap, saying why', () => {
    expect(() => parseSitemap('<urlset><url><loc>x</url>')).toThrow(/malformed/);
    expect(() => parseSitemap('<html><body>Hello</body></html>')).toThrow(/root element is <html>/);
    expect(() => parseSitemap('<rss><channel/></rss>')).toThrow(WebsiteError);
    expect(() => parseSitemap('')).toThrow(/empty/);
  });

  it('never loads an external entity', () => {
    const xxe =
      '<?xml version="1.0"?><!DOCTYPE urlset [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
      '<urlset><url><loc>&xxe;</loc></url></urlset>';
    let result: unknown;
    try {
      result = parseSitemap(xxe);
    } catch (error) {
      result = error;
    }
    // Refused outright, or kept as the literal text: never the file's contents.
    expect(JSON.stringify(result instanceof Error ? result.message : result)).not.toContain('root:');
    if (!(result instanceof Error)) expect(JSON.stringify(result)).toContain('&xxe;');
  });
});

describe('a page’s identity', () => {
  it('is its address, conservatively normalised: fragment gone, query kept', () => {
    expect(normalizeWebsiteUrl('HTTPS://Example.COM:443/News/A?id=7#top')).toEqual({ ok: true, url: 'https://example.com/News/A?id=7' });
    expect(webItemId('https://example.com/a')).toMatch(/^web:[0-9a-f]{64}$/);
    expect(webItemId('https://example.com/a?id=1')).not.toBe(webItemId('https://example.com/a?id=2'));
  });

  it('is never a private, local or credentialed address', () => {
    for (const bad of ['http://localhost/s.xml', 'http://127.0.0.1/s.xml', 'http://[::1]/s.xml', 'http://10.0.0.5/s.xml', 'http://169.254.169.254/latest', 'ftp://e.com/s.xml', 'https://u:p@e.com/s.xml']) {
      expect(normalizeWebsiteUrl(bad).ok).toBe(false);
    }
  });

  it('keeps to one site', () => {
    expect(sameSite('https://www.example.com/a', 'https://example.com/b')).toBe(true);
    expect(sameSite('https://news.example.com/a', 'https://example.com/b')).toBe(true);
    expect(sameSite('https://example.com.evil.net/a', 'https://example.com/b')).toBe(false);
    expect(sameSite('https://other.org/a', 'https://example.com/b')).toBe(false);
  });
});

describe('a sitemap tree, read', () => {
  it('reads a urlset, each page once', async () => {
    const fetch = site({
      [ROOT]: urlset([
        { loc: 'https://news.example.com/a', lastmod: '2026-10-20' },
        { loc: 'https://news.example.com/b' },
        { loc: 'https://news.example.com/a#again' },
      ]),
    });
    const tree = await readSitemapTree(ROOT, fetch);
    expect(tree).toMatchObject({ kind: 'urlset', sitemapsRead: 1, truncated: false });
    expect(tree.pages.map((page) => page.url)).toEqual(['https://news.example.com/a', 'https://news.example.com/b']);
    expect(tree.pages[0]).toMatchObject({ id: webItemId('https://news.example.com/a'), sitemapUrl: ROOT });
  });

  it('follows an index to its sitemaps, a page in two of them once', async () => {
    const fetch = site({
      [ROOT]: index(['https://news.example.com/s1.xml', 'https://news.example.com/s2.xml', 'https://news.example.com/s1.xml']),
      'https://news.example.com/s1.xml': urlset([{ loc: 'https://news.example.com/a' }, { loc: 'https://news.example.com/b' }]),
      'https://news.example.com/s2.xml': urlset([{ loc: 'https://news.example.com/b' }, { loc: 'https://news.example.com/c' }]),
    });
    const tree = await readSitemapTree(ROOT, fetch);
    expect(tree).toMatchObject({ kind: 'index', sitemapsRead: 3, sitemapsFound: 3 });
    expect(tree.pages.map((page) => page.url)).toEqual([
      'https://news.example.com/a',
      'https://news.example.com/b',
      'https://news.example.com/c',
    ]);
    // s1 named twice, read once.
    expect(fetch.asked.filter((url) => url.endsWith('/s1.xml'))).toHaveLength(1);
  });

  it('reads nested indexes only so deep', async () => {
    const level = (n: number) => `https://news.example.com/level${n}.xml`;
    const pages: Record<string, string> = { [ROOT]: index([level(2)]) };
    for (let n = 2; n <= MAX_SITEMAP_DEPTH + 2; n += 1) pages[level(n)] = index([level(n + 1)]);
    const fetch = site(pages);

    const tree = await readSitemapTree(ROOT, fetch);
    expect(tree.sitemapsRead).toBe(MAX_SITEMAP_DEPTH);
    expect(tree.tooDeep).toBe(1);
    expect(fetch.asked).toHaveLength(MAX_SITEMAP_DEPTH);
  });

  it('does not go round a cycle', async () => {
    const other = 'https://news.example.com/other.xml';
    const fetch = site({ [ROOT]: index([other]), [other]: index([ROOT, other]) });
    const tree = await readSitemapTree(ROOT, fetch);
    expect(tree.sitemapsRead).toBe(2);
    expect(fetch.asked).toEqual([ROOT, other]);
  });

  it('reads a gzip sitemap', async () => {
    const gz = 'https://news.example.com/sitemap.xml.gz';
    const fetch = site({ [gz]: gzipSync(urlset([{ loc: 'https://news.example.com/zipped' }])) });
    const tree = await readSitemapTree(gz, fetch);
    expect(tree.pages.map((page) => page.url)).toEqual(['https://news.example.com/zipped']);
  });

  it('refuses a gzip sitemap that inflates past the limit', async () => {
    const bomb = gzipSync(Buffer.alloc(SITEMAP_MAX_UNCOMPRESSED_BYTES + 1024, 0x20));
    expect(bomb.byteLength).toBeLessThan(SITEMAP_MAX_BYTES);
    const fetch = site({ [ROOT]: bomb });
    await expect(fetchSitemap(ROOT, fetch)).rejects.toThrow(/larger than/);
  });

  it('refuses a sitemap larger than the limit, whatever the server says of its length', async () => {
    const fetch = site({
      [ROOT]: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const chunk = new Uint8Array(1024 * 1024).fill(0x20);
              for (let sent = 0; sent <= SITEMAP_MAX_BYTES; sent += chunk.byteLength) controller.enqueue(chunk);
              controller.close();
            },
          }),
          { status: 200 },
        ),
    });
    await expect(fetchSitemap(ROOT, fetch)).rejects.toThrow(/larger than/);
  });

  it('leaves out sitemaps and pages on another site', async () => {
    const fetch = site({
      [ROOT]: index(['https://evil.example.org/s.xml', 'https://news.example.com/s.xml']),
      'https://news.example.com/s.xml': urlset([{ loc: 'https://news.example.com/a' }, { loc: 'https://tracker.example.net/x' }]),
    });
    const tree = await readSitemapTree(ROOT, fetch);
    expect(tree.pages.map((page) => page.url)).toEqual(['https://news.example.com/a']);
    expect(tree.rejected).toBe(2);
    expect(fetch.asked).not.toContain('https://evil.example.org/s.xml');
  });

  it('notes a child sitemap that fails and reads the rest; a root that fails throws', async () => {
    const fetch = site({
      [ROOT]: index(['https://news.example.com/broken.xml', 'https://news.example.com/s.xml']),
      'https://news.example.com/broken.xml': () => new Response('oops', { status: 503 }),
      'https://news.example.com/s.xml': urlset([{ loc: 'https://news.example.com/a' }]),
    });
    const tree = await readSitemapTree(ROOT, fetch);
    expect(tree.failures).toHaveLength(1);
    expect(tree.pages).toHaveLength(1);

    await expect(readSitemapTree('https://news.example.com/missing.xml', fetch)).rejects.toThrow(/gone \(404\)/);
  });

  it('stops at its limits and says so', async () => {
    const fetch = site({
      [ROOT]: urlset(Array.from({ length: 10 }, (_, n) => ({ loc: `https://news.example.com/${n}` }))),
    });
    const tree = await readSitemapTree(ROOT, { ...fetch, maxUrls: 4 });
    expect(tree.pages).toHaveLength(4);
    expect(tree.truncated).toBe(true);

    const late = await readSitemapTree(ROOT, { ...fetch, deadline: 0, now: () => 1 });
    expect(late).toMatchObject({ sitemapsRead: 0, truncated: true });
  });
});

describe('a website fetch', () => {
  const ok = vi.fn(async () => new Response('<urlset/>', { status: 200 })) as unknown as typeof fetch;

  it('refuses local, private and metadata addresses, literal or resolved', async () => {
    for (const url of ['http://localhost/s.xml', 'http://127.0.0.1/s.xml', 'http://[::1]/s.xml', 'http://192.168.1.1/s.xml', 'http://169.254.169.254/latest/meta-data']) {
      await expect(fetchPublic(url, { fetchImpl: ok, accept: '*/*', maxBytes: 1000, what: 'sitemap' })).rejects.toMatchObject({
        code: 'website_url_unsafe',
      });
    }
    await expect(
      fetchPublic('https://inside.example.com/s.xml', {
        fetchImpl: ok,
        lookup: async () => ['10.1.2.3'],
        accept: '*/*',
        maxBytes: 1000,
        what: 'sitemap',
      }),
    ).rejects.toThrow(/private or local/);
    expect(ok).not.toHaveBeenCalled();
  });

  it('checks every redirect hop, and stops a redirect to a private address before it is fetched', async () => {
    const asked: string[] = [];
    const fetchImpl = vi.fn(async (input: unknown) => {
      asked.push(String(input));
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    }) as unknown as typeof fetch;
    await expect(
      fetchPublic(ROOT, { fetchImpl, lookup: async () => ['93.184.215.14'], accept: '*/*', maxBytes: 1000, what: 'sitemap' }),
    ).rejects.toMatchObject({ code: 'website_url_unsafe' });
    expect(asked).toEqual([ROOT]);
  });

  it('stops after too many redirects', async () => {
    let hop = 0;
    const fetchImpl = vi.fn(async () => new Response(null, { status: 301, headers: { location: `/r${(hop += 1)}` } })) as unknown as typeof fetch;
    await expect(
      fetchPublic(ROOT, { fetchImpl, lookup: async () => ['93.184.215.14'], accept: '*/*', maxBytes: 1000, what: 'sitemap' }),
    ).rejects.toThrow(/too many times/);
  });

  it('tells a block or a server error, worth retrying, from a page that is gone', async () => {
    const answer = (status: number) =>
      fetchPublic(ROOT, {
        fetchImpl: vi.fn(async () => new Response('', { status })) as unknown as typeof fetch,
        lookup: async () => ['93.184.215.14'],
        accept: '*/*',
        maxBytes: 1000,
        what: 'page',
      });
    await expect(answer(403)).rejects.toMatchObject({ transient: true, code: 'website_blocked' });
    await expect(answer(503)).rejects.toMatchObject({ transient: true });
    await expect(answer(404)).rejects.toMatchObject({ transient: false, code: 'website_not_found' });
    await expect(answer(410)).rejects.toMatchObject({ transient: false });
  });
});
