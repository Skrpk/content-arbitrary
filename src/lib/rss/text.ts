/**
 * Feed text to plain text.
 *
 * Feeds carry text in two layers: XML, whose entities the parser is told to
 * leave alone (so a hostile DOCTYPE can never expand them), and very often
 * HTML inside that, escaped or in CDATA. decodeXmlEntities undoes the first;
 * htmlToText the second.
 */

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** The handful of named entities feeds actually use, beyond XML's five. */
const HTML_ENTITIES: Record<string, string> = {
  ...XML_ENTITIES,
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  deg: '°',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  minus: '−',
  plusmn: '±',
  frac12: '½',
  euro: '€',
  pound: '£',
  cent: '¢',
  sect: '§',
  para: '¶',
  shy: '',
  zwj: '\u200d',
  zwnj: '\u200c',
  thinsp: ' ',
  ensp: ' ',
  emsp: ' ',
  eacute: 'é',
  egrave: 'è',
  aacute: 'á',
  agrave: 'à',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  ntilde: 'ñ',
  ccedil: 'ç',
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  szlig: 'ß',
  micro: 'µ',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  lambda: 'λ',
  mu: 'μ',
  pi: 'π',
  sigma: 'σ',
  omega: 'ω',
};

function decodeWith(table: Record<string, string>, text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      // Lone surrogates and out-of-range code points would throw; keep the text as it was.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return match;
      return String.fromCodePoint(code);
    }
    return table[name] ?? table[name.toLowerCase()] ?? match;
  });
}

/** XML's five entities and numeric references — what the parser left undecoded. */
export function decodeXmlEntities(text: string): string {
  return decodeWith(XML_ENTITIES, text);
}

/** Entities as HTML has them: XML's, numeric, and the common named ones. */
export function decodeHtmlEntities(text: string): string {
  return decodeWith(HTML_ENTITIES, text);
}

const DROPPED_BLOCKS = /<(script|style|nav|header|footer|aside|form|noscript|iframe|svg|figure)\b[\s\S]*?<\/\1\s*>/gi;
const INLINE_TAGS = /<\/?(a|b|strong|em|i|u|s|span|small|big|sup|sub|abbr|code|mark|cite|q|time|font)\b[^>]*>/gi;
const LINE_BREAKS = /<\s*(br|hr)\b[^>]*>|<\/\s*(p|div|h[1-6]|blockquote|tr|section|article|ul|ol|table|pre)\s*>/gi;

/**
 * Readable text out of a fragment of HTML: no tags, no scripts or navigation,
 * entities decoded, paragraphs kept as blank lines, everything else folded
 * to single spaces. Plain text goes through unchanged but for whitespace.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(DROPPED_BLOCKS, ' ')
    .replace(/<\s*li\b[^>]*>/gi, '\n• ')
    .replace(/<\/\s*li\s*>/gi, '')
    .replace(LINE_BREAKS, '\n')
    // Inline tags sit inside words and before punctuation: drop them without a gap.
    .replace(INLINE_TAGS, '')
    .replace(/<[^>]*>/g, ' ');

  // List items one per line, without the blank lines the source's own line breaks add between them.
  return normalizeWhitespace(decodeHtmlEntities(text)).replace(/\n\n(?=• )/g, '\n');
}

/** Spaces folded within lines, at most one blank line between paragraphs, ends trimmed. */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t\f\v \u00a0\u2000-\u200a\u202f\u205f\u3000]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^•$/gm, '')
    .trim();
}
