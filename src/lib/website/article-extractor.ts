import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import { htmlToText, normalizeWhitespace } from '@/lib/rss/text';
import { blockedHostReason } from '@/lib/rss/url';
import { sameSite } from '@/lib/website/url';

/**
 * A web page's article, read deterministically — no model, no browser: the
 * page's HTML is parsed by jsdom with scripts off and nothing loaded (no
 * scripts run, no stylesheets, images or frames fetched), and Mozilla's
 * Readability — Firefox's Reader View — finds the article in it, leaving the
 * navigation, sidebars and footers behind. What comes out is plain text; the
 * page's HTML is not kept.
 *
 * Not every page a sitemap lists is an article — a category, a tag, an
 * author's page, a product. Cheap signals tell them apart: Readability must
 * find something, with a real title and enough text; the page must not
 * declare itself a listing, nor read as one — headings that are links. A page whose article only a browser running its
 * scripts would see has too little text, and is turned away the same way.
 */

/** Text an article must have at least, in characters: a few paragraphs, not a teaser or a list of links. */
export const MIN_ARTICLE_TEXT_LENGTH = 400;
/** Less is enough for a page that declares itself an article in its structured data. */
export const MIN_DECLARED_ARTICLE_TEXT_LENGTH = 200;
const MIN_TITLE_LENGTH = 5;
/** Headings that link elsewhere, from which a page reads as a list of articles. */
const LISTING_LINKED_HEADINGS = 3;
/** A site's name as the page gives it is untrusted; past this it is not a name. */
const SITE_NAME_MAX = 100;

export interface ExtractedArticle {
  title: string;
  /** The article's text, paragraphs as blank lines. */
  text: string;
  /** Its summary: the page's description, or Readability's first paragraph. */
  excerpt: string | null;
  byline: string | null;
  siteName: string | null;
  lang: string | null;
  /** When it was published, as the page says: its structured data or its article meta. */
  publishedAt: Date | null;
  /** The page's own canonical address, only when it is a safe one on the same site. */
  canonicalUrl: string | null;
  /** Its og:image, when it names an http(s) one. */
  imageUrl: string | null;
  /** Whether its structured data declares it an Article, a NewsArticle or a BlogPosting. */
  declaredArticle: boolean;
}

export type ArticleExtraction = { ok: true; article: ExtractedArticle } | { ok: false; reason: string };

const ARTICLE_TYPES = /^(?:Article|NewsArticle|BlogPosting|Report|ReportageNewsArticle|AnalysisNewsArticle|OpinionNewsArticle|ReviewNewsArticle|BackgroundNewsArticle|ScholarlyArticle|TechArticle|LiveBlogPosting|SocialMediaPosting)$/;
const LISTING_TYPES = /^(?:CollectionPage|ItemList|SearchResultsPage|ProfilePage|Product|ProductGroup|ContactPage|AboutPage|FAQPage)$/;

export function extractArticle(html: string, pageUrl: string): ArticleExtraction {
  // A console of its own that reports nothing: a page's broken CSS is not our log's business.
  const dom = new JSDOM(html, { url: pageUrl, contentType: 'text/html', virtualConsole: new VirtualConsole() });
  try {
    const document = dom.window.document;
    // Read before Readability, which rearranges the document as it works.
    const meta = readMetadata(document, pageUrl);
    const parsed = new Readability(document, { keepClasses: false }).parse();
    if (!parsed) return { ok: false, reason: 'no readable article on the page' };

    const title = clean(parsed.title) || meta.ogTitle || '';
    const text = htmlToText(parsed.content ?? '') || normalizeWhitespace(parsed.textContent ?? '');

    if (meta.listing && !meta.declaredArticle) return { ok: false, reason: `the page declares itself a ${meta.listing}` };
    if (!meta.declaredArticle && isListOfArticles(parsed.content ?? '')) return { ok: false, reason: 'a list of articles, not one' };
    if (title.length < MIN_TITLE_LENGTH) return { ok: false, reason: 'the page has no title' };
    if (!meta.declaredArticle && isSiteRoot(pageUrl)) return { ok: false, reason: 'the site’s home page' };
    const minimum = meta.declaredArticle ? MIN_DECLARED_ARTICLE_TEXT_LENGTH : MIN_ARTICLE_TEXT_LENGTH;
    if (text.length < minimum) return { ok: false, reason: `too little text for an article (${text.length} characters)` };

    const siteName = clean(parsed.siteName) || meta.siteName;
    return {
      ok: true,
      article: {
        title,
        text,
        excerpt: clean(parsed.excerpt) || null,
        byline: clean(parsed.byline) || meta.author || null,
        siteName: siteName && siteName.length <= SITE_NAME_MAX ? siteName : null,
        lang: clean(parsed.lang) || meta.lang || null,
        publishedAt: dateOf(parsed.publishedTime) ?? meta.publishedAt,
        canonicalUrl: meta.canonicalUrl,
        imageUrl: meta.imageUrl,
        declaredArticle: meta.declaredArticle,
      },
    };
  } finally {
    dom.window.close();
  }
}

interface PageMetadata {
  canonicalUrl: string | null;
  imageUrl: string | null;
  publishedAt: Date | null;
  author: string | null;
  siteName: string | null;
  ogTitle: string | null;
  lang: string | null;
  declaredArticle: boolean;
  /** The listing type the page declares itself, if any. */
  listing: string | null;
}

function readMetadata(document: Document, pageUrl: string): PageMetadata {
  const metaContent = (selector: string) => clean(document.querySelector(selector)?.getAttribute('content')) || null;
  const structured = structuredData(document);
  const ogType = metaContent('meta[property="og:type"]');

  return {
    canonicalUrl: safeCanonical(document.querySelector('link[rel~="canonical"]')?.getAttribute('href'), pageUrl),
    imageUrl: httpUrl(metaContent('meta[property="og:image"]') ?? metaContent('meta[name="twitter:image"]'), pageUrl),
    publishedAt:
      structured.datePublished ??
      dateOf(metaContent('meta[property="article:published_time"]')) ??
      dateOf(metaContent('meta[itemprop="datePublished"]')),
    author: structured.author ?? metaContent('meta[name="author"]'),
    siteName: metaContent('meta[property="og:site_name"]'),
    ogTitle: metaContent('meta[property="og:title"]'),
    lang: clean(document.documentElement.getAttribute('lang')) || null,
    declaredArticle: structured.types.some((type) => ARTICLE_TYPES.test(type)) || ogType === 'article',
    listing: structured.types.find((type) => LISTING_TYPES.test(type)) ?? null,
  };
}

/** What a page's JSON-LD says of itself: its types, and an article's date and author. Malformed blocks are passed over. */
function structuredData(document: Document): { types: string[]; datePublished: Date | null; author: string | null } {
  const types: string[] = [];
  let datePublished: Date | null = null;
  let author: string | null = null;

  const visit = (node: unknown, depth: number) => {
    if (depth > 6 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    const type = record['@type'];
    const own = (Array.isArray(type) ? type : [type]).filter((value): value is string => typeof value === 'string');
    types.push(...own);
    if (own.some((value) => ARTICLE_TYPES.test(value))) {
      datePublished ??= dateOf(typeof record.datePublished === 'string' ? record.datePublished : null);
      author ??= authorName(record.author);
    }
    if ('@graph' in record) visit(record['@graph'], depth + 1);
    if ('mainEntity' in record) visit(record.mainEntity, depth + 1);
  };

  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      visit(JSON.parse(script.textContent ?? ''), 0);
    } catch {
      // A broken block says nothing.
    }
  }
  return { types, datePublished, author };
}

function authorName(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === 'string') return clean(first) || null;
  if (first && typeof first === 'object' && typeof (first as { name?: unknown }).name === 'string') {
    return clean((first as { name: string }).name) || null;
  }
  return null;
}

/**
 * The page's canonical address, only when it is one we would link to: http(s),
 * not a private or local host, and on the same site — a page cannot send its
 * post off to somewhere else.
 */
function safeCanonical(href: string | null | undefined, pageUrl: string): string | null {
  const url = httpUrl(href, pageUrl);
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.username || parsed.password || blockedHostReason(parsed.hostname)) return null;
  if (!sameSite(parsed, pageUrl)) return null;
  parsed.hash = '';
  return parsed.toString();
}

function httpUrl(value: string | null | undefined, base: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim(), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Whether what Readability found is a list of other articles — a blog's
 * front page, a category, an author's page: several headings, most of them
 * links to the articles they name. An article's own headings are rarely links.
 */
function isListOfArticles(contentHtml: string): boolean {
  const headings = [...JSDOM.fragment(contentHtml).querySelectorAll('h1, h2, h3, h4')];
  const linked = headings.filter((heading) => heading.querySelector('a') !== null || heading.closest('a') !== null).length;
  return linked >= LISTING_LINKED_HEADINGS && linked * 2 >= headings.length;
}

function isSiteRoot(pageUrl: string): boolean {
  const url = new URL(pageUrl);
  return (url.pathname === '/' || url.pathname === '') && url.search === '';
}

function dateOf(value: string | null | undefined): Date | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : null;
}

function clean(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}
