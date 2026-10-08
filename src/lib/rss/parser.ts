import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { FeedError } from '@/lib/errors';
import { entryStableKey } from '@/lib/rss/identity';
import { decodeXmlEntities, htmlToText } from '@/lib/rss/text';
import type { FeedFormat, ParsedFeed, ParsedFeedEntry } from '@/lib/rss/types';

/**
 * RSS 2.0 and Atom 1.0, from XML to ParsedFeed.
 *
 * The parser is configured defensively: entities are not processed at all —
 * so no DOCTYPE can define one, expand one a billion times or reach outside
 * the document — and values stay strings, so a numeric guid is not turned
 * into a number. The few entities feeds legitimately use are decoded by hand
 * afterwards (text.ts). What the size of the document may be is the
 * client's to bound, before this is ever called.
 */

const REPEATED = new Set(['item', 'entry', 'link', 'category', 'author', 'guid', 'id']);

/**
 * Elements that may hold markup — escaped HTML, CDATA or Atom's inline xhtml.
 * They are kept raw, in order, and turned into text in one place (`markup`),
 * rather than being half-parsed as XML.
 */
const MARKUP_NODES = [
  'rss.channel.title',
  'rss.channel.item.title',
  'rss.channel.item.description',
  'rss.channel.item.content:encoded',
  'feed.title',
  'feed.entry.title',
  'feed.entry.summary',
  'feed.entry.content',
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false,
  htmlEntities: false,
  cdataPropName: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  isArray: (name) => REPEATED.has(name),
  stopNodes: MARKUP_NODES,
});

type Node = unknown;
type Element = Record<string, Node>;

const asElement = (node: Node): Element | null =>
  node !== null && typeof node === 'object' && !Array.isArray(node) ? (node as Element) : null;

const asList = (node: Node): Node[] => (node === undefined || node === null ? [] : Array.isArray(node) ? node : [node]);

/** An element's own text, whether it came as a bare string or with attributes. */
function ownText(node: Node): string | null {
  for (const item of asList(node)) {
    if (typeof item === 'string' || typeof item === 'number') {
      const text = decodeXmlEntities(String(item)).trim();
      if (text) return text;
    }
    const element = asElement(item);
    if (element && element['#text'] !== undefined) {
      const text = decodeXmlEntities(String(element['#text'])).trim();
      if (text) return text;
    }
  }
  return null;
}

/**
 * A markup element's content as HTML: CDATA sections exactly as written, the
 * rest with its XML entities decoded — so escaped HTML becomes HTML, and
 * inline xhtml stays as it was.
 */
function markup(node: Node): string | null {
  const first = asList(node)[0];
  const raw =
    typeof first === 'string' ? first : typeof asElement(first)?.['#text'] === 'string' ? (asElement(first)!['#text'] as string) : '';
  const html = raw
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
    .map((part) => (part.startsWith('<![CDATA[') ? part.slice(9, -3) : decodeXmlEntities(part)))
    .join('')
    .trim();
  return html || null;
}

/** A title as plain text. */
function titleText(node: Node): string | null {
  return htmlToText(markup(node) ?? '') || null;
}

function attribute(node: Node, name: string): string | null {
  const value = asElement(node)?.[`@_${name}`];
  return typeof value === 'string' && value.trim() ? decodeXmlEntities(value.trim()) : null;
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** An absolute http(s) URL, resolved against the feed's; null for anything else. */
function absoluteUrl(value: string | null, base: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function parseFeed(xml: string, feedUrl: string): ParsedFeed {
  const valid = XMLValidator.validate(xml);
  if (valid !== true) {
    throw new FeedError(`Not well-formed XML: ${valid.err.msg} (line ${valid.err.line})`, {
      transient: false,
      code: 'feed_invalid_xml',
    });
  }

  let document: Element;
  try {
    document = parser.parse(xml) as Element;
  } catch (error) {
    throw new FeedError('Not well-formed XML', { transient: false, code: 'feed_invalid_xml', cause: error });
  }

  const rss = asElement(document.rss);
  if (rss) return parseRss(rss, feedUrl);
  const atom = asElement(document.feed);
  if (atom) return parseAtom(atom, feedUrl);

  throw new FeedError('Not an RSS 2.0 or Atom feed', { transient: false, code: 'feed_unsupported' });
}

function parseRss(rss: Element, feedUrl: string): ParsedFeed {
  const channel = asElement(rss.channel);
  if (!channel) throw new FeedError('RSS feed has no <channel>', { transient: false, code: 'feed_unsupported' });

  // <link> may sit beside atom:link self references; the site is the plain one.
  const siteLink = asList(channel.link)
    .map((link) => (typeof link === 'string' ? decodeXmlEntities(link.trim()) : null))
    .find(Boolean);

  const entries = asList(channel.item).flatMap((node) => {
    const item = asElement(node);
    if (!item) return [];

    const title = titleText(item.title);
    const summary = markup(item.description);
    const content = markup(item['content:encoded']);
    const url = absoluteUrl(
      asList(item.link)
        .map((link) => (typeof link === 'string' ? decodeXmlEntities(link.trim()) : attribute(link, 'href')))
        .find(Boolean) ?? null,
      feedUrl,
    );
    const guid = ownText(item.guid);
    const publishedAt = parseDate(ownText(item.pubDate) ?? ownText(item['dc:date']));

    return [
      toEntry({
        guid,
        url,
        title,
        summary,
        content,
        author: ownText(item['dc:creator']) ?? ownText(item.author),
        publishedAt,
        updatedAt: null,
      }),
    ];
  });

  return {
    format: 'rss2',
    title: titleText(channel.title),
    siteUrl: absoluteUrl(siteLink ?? null, feedUrl),
    feedUrl,
    entries,
  };
}

function parseAtom(feed: Element, feedUrl: string): ParsedFeed {
  const entries = asList(feed.entry).flatMap((node) => {
    const entry = asElement(node);
    if (!entry) return [];

    const author = asList(entry.author)
      .map((value) => ownText(asElement(value)?.name))
      .find(Boolean);

    return [
      toEntry({
        atomId: ownText(entry.id),
        url: atomLink(entry.link, feedUrl),
        title: titleText(entry.title),
        summary: markup(entry.summary),
        content: markup(entry.content),
        author: author ?? null,
        publishedAt: parseDate(ownText(entry.published)),
        updatedAt: parseDate(ownText(entry.updated)),
      }),
    ];
  });

  return {
    format: 'atom' satisfies FeedFormat,
    title: titleText(feed.title),
    siteUrl: atomLink(feed.link, feedUrl),
    feedUrl,
    entries,
  };
}

/** The entry's page: its rel="alternate" link, or one with no rel at all. */
function atomLink(links: Node, base: string): string | null {
  const candidates = asList(links);
  const preferred =
    candidates.find((link) => attribute(link, 'rel') === 'alternate') ??
    candidates.find((link) => attribute(link, 'rel') === null);
  return absoluteUrl(preferred ? attribute(preferred, 'href') : null, base);
}

function toEntry(fields: {
  atomId?: string | null;
  guid?: string | null;
  url: string | null;
  title: string | null;
  summary: string | null;
  content: string | null;
  author: string | null;
  publishedAt: Date | null;
  updatedAt: Date | null;
}): ParsedFeedEntry {
  const { atomId, guid, ...entry } = fields;
  return {
    ...entry,
    stableId: entryStableKey({
      atomId,
      guid,
      link: entry.url,
      title: entry.title,
      publishedAt: entry.publishedAt ?? entry.updatedAt,
      text: htmlToText(entry.summary ?? entry.content ?? ''),
    }),
  };
}
