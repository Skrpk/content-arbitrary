import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { WebsiteError } from '@/lib/errors';
import { decodeXmlEntities } from '@/lib/rss/text';

/**
 * A sitemap, from XML to the addresses it lists: a `<urlset>` of pages or a
 * `<sitemapindex>` of further sitemaps (sitemaps.org protocol), in whatever
 * namespace prefix the site writes them.
 *
 * The parser is set up as the feed parser is (src/lib/rss/parser.ts):
 * entities are not processed at all, so a DOCTYPE can neither define one,
 * expand one a billion times nor reach outside the document — there is no
 * external entity or DTD loading of any kind — and the few entities a
 * sitemap really uses, `&amp;` in a query above all, are decoded by hand
 * afterwards. What the size of the document may be is the fetcher's to bound.
 */

export interface SitemapEntry {
  /** The address as written: untrusted, to be normalised and checked before use. */
  loc: string;
  /** `<lastmod>`: when the page last changed, as the site says — not when it was published. */
  lastmod: Date | null;
  /** A news sitemap's `<news:publication_date>`, when it has one. */
  published: Date | null;
}

export type ParsedSitemap = { kind: 'urlset'; urls: SitemapEntry[] } | { kind: 'index'; sitemaps: SitemapEntry[] };

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false,
  htmlEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  isArray: (name, path) => path === 'urlset.url' || path === 'sitemapindex.sitemap',
});

export function parseSitemap(xml: string): ParsedSitemap {
  const text = xml.replace(/^﻿/, '').trim();
  if (text === '') throw notASitemap('it is empty');

  const valid = XMLValidator.validate(text);
  if (valid !== true) throw notASitemap(`the XML is malformed (${valid.err.msg}, line ${valid.err.line})`);

  let document: Record<string, unknown>;
  try {
    document = parser.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw notASitemap(`the XML could not be read (${error instanceof Error ? error.message : 'unknown error'})`);
  }

  if ('urlset' in document) return { kind: 'urlset', urls: entriesOf(document.urlset, 'url') };
  if ('sitemapindex' in document) return { kind: 'index', sitemaps: entriesOf(document.sitemapindex, 'sitemap') };

  const root = Object.keys(document).find((key) => !key.startsWith('?') && key !== '#text');
  throw notASitemap(root ? `its root element is <${root}>, not <urlset> or <sitemapindex>` : 'it has no root element');
}

function entriesOf(container: unknown, name: 'url' | 'sitemap'): SitemapEntry[] {
  const element = asElement(container);
  if (!element) return [];
  const items = Array.isArray(element[name]) ? (element[name] as unknown[]) : [];

  return items.flatMap((item): SitemapEntry[] => {
    const entry = asElement(item);
    const loc = textOf(entry?.loc);
    if (!entry || !loc) return [];
    return [
      {
        loc: decodeXmlEntities(loc).trim(),
        lastmod: dateOf(textOf(entry.lastmod)),
        published: dateOf(textOf(asElement(entry.news)?.publication_date)),
      },
    ];
  });
}

function asElement(node: unknown): Record<string, unknown> | null {
  return node !== null && typeof node === 'object' && !Array.isArray(node) ? (node as Record<string, unknown>) : null;
}

/** An element's text, whether it came as a bare string or with attributes; null when it has none. */
function textOf(node: unknown): string | null {
  if (typeof node === 'string') return node.trim() || null;
  const element = asElement(node);
  const text = element?.['#text'];
  return typeof text === 'string' ? text.trim() || null : null;
}

/** A W3C datetime, or null when it is missing or not a date. */
function dateOf(value: string | null): Date | null {
  if (!value) return null;
  const time = Date.parse(decodeXmlEntities(value));
  return Number.isFinite(time) ? new Date(time) : null;
}

function notASitemap(why: string): WebsiteError {
  return new WebsiteError(`Not a sitemap: ${why}.`, { transient: false, code: 'website_not_sitemap' });
}
