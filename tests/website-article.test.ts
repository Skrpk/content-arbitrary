import { describe, expect, it, vi } from 'vitest';
import { ARTICLE_MAX_BYTES, fetchArticlePage } from '@/lib/website/article-client';
import { extractArticle, MIN_ARTICLE_TEXT_LENGTH } from '@/lib/website/article-extractor';
import { articleToPost, WEBSITE_ANALYSIS_MAX, WEBSITE_TEXT_MAX } from '@/lib/website/normalize';
import { webItemId } from '@/lib/website/url';

/**
 * A website's page: read as an article — or turned away as none — without a
 * model, a browser or any of the page's scripts.
 */

const PAGE = 'https://news.example.com/2026/10/webb-finds-water';

const paragraphs = (n: number, topic = 'the planet') =>
  Array.from(
    { length: n },
    (_, i) =>
      `<p>Paragraph ${i + 1} on ${topic}: astronomers using the James Webb Space Telescope report a clear signal of water vapour, and explain at some length what the measurement means for the planet's atmosphere and for the search that follows.</p>`,
  ).join('\n');

function page(options: { head?: string; body: string; lang?: string }): string {
  return `<!doctype html><html lang="${options.lang ?? 'en'}"><head><meta charset="utf-8"><title>Webb finds water on a distant world | Example News</title>${options.head ?? ''}</head><body>${options.body}</body></html>`;
}

const chrome = (inner: string) =>
  `<header><nav><a href="/">Home</a> <a href="/space">Space</a> <a href="/science">Science</a> <a href="/subscribe">Subscribe now</a></nav></header>` +
  `<div class="layout"><aside class="sidebar"><h3>Most read</h3><ul><li><a href="/x">Something else entirely</a></li><li><a href="/y">Yet another story</a></li></ul></aside>` +
  `<main>${inner}</main></div>` +
  `<footer><p>© 2026 Example News. All rights reserved. Terms · Privacy · Cookie settings</p></footer>`;

const article = (extra = '') =>
  page({
    head:
      '<meta property="og:site_name" content="Example News">' +
      '<meta property="article:published_time" content="2026-10-20T08:30:00Z">' +
      '<meta name="description" content="Astronomers using Webb report a clear water signal from a planet 120 light years away, the strongest such detection yet.">' +
      '<meta property="og:image" content="/images/webb.jpg">' +
      extra,
    body: chrome(`<article><h1>Webb finds water on a distant world</h1><p class="byline">By Jane Doe</p>${paragraphs(6)}</article>`),
  });

describe('a page’s article', () => {
  it('is read from a news page: title, body, date, site and author', () => {
    const result = extractArticle(article(), PAGE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.article.title).toMatch(/Webb finds water on a distant world/);
    expect(result.article.text).toContain('Paragraph 1 on the planet');
    expect(result.article.text).toContain('Paragraph 6 on the planet');
    expect(result.article.publishedAt).toEqual(new Date('2026-10-20T08:30:00Z'));
    expect(result.article.siteName).toBe('Example News');
    expect(result.article.lang).toBe('en');
    expect(result.article.imageUrl).toBe('https://news.example.com/images/webb.jpg');
  });

  it('leaves the navigation, the sidebar and the footer behind', () => {
    const result = extractArticle(article(), PAGE);
    if (!result.ok) throw new Error(result.reason);
    expect(result.article.text).not.toContain('Subscribe now');
    expect(result.article.text).not.toContain('Most read');
    expect(result.article.text).not.toContain('All rights reserved');
  });

  it('reads JSON-LD: the date and the author, and that it is an article', () => {
    const jsonLd = JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', name: 'Example News' },
        { '@type': 'NewsArticle', headline: 'Webb finds water', datePublished: '2026-10-19T06:00:00Z', author: [{ '@type': 'Person', name: 'Ada Lovelace' }] },
      ],
    });
    const html = page({
      head: `<script type="application/ld+json">${jsonLd}</script>`,
      body: chrome(`<article><h1>Webb finds water on a distant world</h1>${paragraphs(2)}</article>`),
    });
    const result = extractArticle(html, PAGE);
    if (!result.ok) throw new Error(result.reason);
    expect(result.article.declaredArticle).toBe(true);
    expect(result.article.publishedAt).toEqual(new Date('2026-10-19T06:00:00Z'));
    expect(result.article.byline).toBeTruthy();
  });

  it('is read without any structured metadata at all', () => {
    const html = `<html><head><title>Plain blog post about telescopes</title></head><body>${chrome(`<div><h1>Plain blog post about telescopes</h1>${paragraphs(5, 'telescopes')}</div>`)}</body></html>`;
    const result = extractArticle(html, 'https://blog.example.com/telescopes');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.article.publishedAt).toBeNull();
  });

  it('turns away a category page — a list of other articles', () => {
    const teasers = Array.from(
      { length: 6 },
      (_, i) => `<div class="teaser"><h2><a href="/story-${i}">Story number ${i} with a long enough headline</a></h2><p>A teaser for story ${i}, a sentence or two about what it covers and why it matters to readers of the site.</p></div>`,
    ).join('');
    const result = extractArticle(page({ body: chrome(`<section><h1>Space</h1>${teasers}</section>`) }), 'https://news.example.com/space/');
    expect(result).toMatchObject({ ok: false });
  });

  it('turns away a page that declares itself a listing', () => {
    const html = page({
      head: `<script type="application/ld+json">${JSON.stringify({ '@type': 'CollectionPage', name: 'Space' })}</script>`,
      body: chrome(`<article><h1>All about space</h1>${paragraphs(5)}</article>`),
    });
    expect(extractArticle(html, 'https://news.example.com/space')).toEqual({ ok: false, reason: 'the page declares itself a CollectionPage' });
  });

  it('turns away a page with too little text', () => {
    const result = extractArticle(page({ body: '<article><h1>Short note</h1><p>Just a line.</p></article>' }), PAGE);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(/no readable article|too little text/);
    expect(MIN_ARTICLE_TEXT_LENGTH).toBeGreaterThanOrEqual(300);
  });

  it('fails gracefully on a page only scripts would fill', () => {
    const html = page({ body: '<div id="root"></div><script src="/app.js"></script><noscript>You need JavaScript to run this app.</noscript>' });
    const result = extractArticle(html, PAGE);
    expect(result.ok).toBe(false);
  });

  it('never runs the page’s scripts', () => {
    const marker = `executed-${Math.random()}`;
    const html = article(`<script>globalThis.${'leak'} = '${marker}'; document.title = 'hacked';</script>`);
    const result = extractArticle(html, PAGE);
    expect((globalThis as Record<string, unknown>).leak).toBeUndefined();
    if (result.ok) expect(result.article.title).not.toBe('hacked');
  });

  it('takes a same-site canonical address', () => {
    const result = extractArticle(article('<link rel="canonical" href="https://www.news.example.com/webb-finds-water?ref=x#top">'), PAGE);
    if (!result.ok) throw new Error(result.reason);
    expect(result.article.canonicalUrl).toBe('https://www.news.example.com/webb-finds-water?ref=x');
  });

  it('ignores a canonical address on another site, on a private host, or not http(s)', () => {
    for (const href of ['https://evil.example.org/phish', 'http://127.0.0.1/admin', 'http://localhost/x', 'javascript:alert(1)']) {
      const result = extractArticle(article(`<link rel="canonical" href="${href}">`), PAGE);
      if (!result.ok) throw new Error(result.reason);
      expect(result.article.canonicalUrl).toBeNull();
    }
  });
});

describe('a page, fetched', () => {
  const lookup = async () => ['93.184.215.14'];

  it('is HTML, in the charset it names', async () => {
    const latin = new Uint8Array([...new TextEncoder().encode('<html><body>caf'), 0xe9, ...new TextEncoder().encode('</body></html>')]);
    const fetchImpl = vi.fn(async () => new Response(latin, { headers: { 'content-type': 'text/html; charset=iso-8859-1' } })) as unknown as typeof fetch;
    expect((await fetchArticlePage(PAGE, { fetchImpl, lookup })).html).toContain('café');
  });

  it('is refused when it is not HTML', async () => {
    const fetchImpl = vi.fn(async () => new Response('%PDF-1.7', { headers: { 'content-type': 'application/pdf' } })) as unknown as typeof fetch;
    await expect(fetchArticlePage(PAGE, { fetchImpl, lookup })).rejects.toMatchObject({ code: 'website_not_html', transient: false });
  });

  it('is refused past the size limit', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const chunk = new TextEncoder().encode(`<p>${'x'.repeat(1024 * 1024)}</p>`);
              for (let sent = 0; sent <= ARTICLE_MAX_BYTES; sent += chunk.byteLength) controller.enqueue(chunk);
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/html' } },
        ),
    ) as unknown as typeof fetch;
    await expect(fetchArticlePage(PAGE, { fetchImpl, lookup })).rejects.toMatchObject({ code: 'website_too_large' });
  });
});

describe('an article as a post', () => {
  const discovered = {
    url: PAGE,
    id: webItemId(PAGE),
    lastmod: new Date('2026-10-21T00:00:00Z'),
    published: null,
    sitemapUrl: 'https://news.example.com/sitemap.xml',
    finalUrl: PAGE,
  };

  it('carries its title and lead as text, the whole article as analysis text, and no media', () => {
    const result = extractArticle(article(), PAGE);
    if (!result.ok) throw new Error(result.reason);
    const post = articleToPost(result.article, discovered, { username: 'news.example.com' });

    expect(post).toMatchObject({ platform: 'website', id: discovered.id, url: PAGE, authorUsername: 'Example News', media: [] });
    expect(post.createdAt).toEqual(new Date('2026-10-20T08:30:00Z'));
    expect(post.text.startsWith('Webb finds water on a distant world')).toBe(true);
    expect(post.text).toContain('strongest such detection yet');
    expect(post.text.length).toBeLessThanOrEqual(WEBSITE_TEXT_MAX);
    expect(post.analysisText).toContain('Paragraph 6 on the planet');
    expect(post.sourceMetadata?.website).toMatchObject({ sitemapUrl: discovered.sitemapUrl, originalUrl: null, extractedLength: result.article.text.length });
  });

  it('links the canonical address, keeps the sitemap’s as the original, and its id', () => {
    const result = extractArticle(article('<link rel="canonical" href="https://news.example.com/webb">'), PAGE);
    if (!result.ok) throw new Error(result.reason);
    const post = articleToPost(result.article, discovered, { username: 'news.example.com' });
    expect(post.url).toBe('https://news.example.com/webb');
    expect(post.id).toBe(webItemId(PAGE));
    expect(post.sourceMetadata?.website?.originalUrl).toBe(PAGE);
  });

  it('bounds a very long article, and falls back to the sitemap’s date', () => {
    const long = { title: 'A very long read', text: 'word '.repeat(40_000), excerpt: null, byline: null, siteName: null, lang: null, publishedAt: null, canonicalUrl: null, imageUrl: null, declaredArticle: false };
    const post = articleToPost(long, discovered, { username: 'news.example.com' });
    expect(post.analysisText!.length).toBeLessThanOrEqual(WEBSITE_ANALYSIS_MAX);
    expect(post.text.length).toBeLessThanOrEqual(WEBSITE_TEXT_MAX);
    expect(post.createdAt).toEqual(discovered.lastmod);
    expect(post.authorUsername).toBe('news.example.com');
  });
});
