import { HTMLElement, NodeType, parse, type Node } from 'node-html-parser';
import { escapeHtml } from '@/lib/telegram/format-caption';
import type { RichBlock, RichDocument, RichInline } from '@/lib/rich/document';

/**
 * The editor's document as a small HTML a language model can read and write
 * back — for the post editor's AI assistant — and the way back.
 *
 * Only what a rich message holds: `<p>`, `<h1>`–`<h3>`, `<b>`, `<i>`, `<u>`,
 * `<s>`, `<mark>`, `<a href>`, `<br>`, `<ul>`/`<ol>` with `<li>`,
 * `<blockquote>`, `<hr>`, and the post's own pictures as
 * `<media ref="m0">caption</media>`. Reading it back is lenient about what a
 * model writes around that (a `<strong>`, a `<div>`, a stray line of text)
 * and keeps nothing else: whatever comes out is a document to check with
 * parseRichDocument, like any the editor sends.
 */

type MarkName = 'bold' | 'italic' | 'underline' | 'strike' | 'highlight';
type Mark = { type: MarkName } | { type: 'link'; attrs: { href: string } };

const MARK_TAGS: Record<MarkName, string> = {
  bold: 'b',
  italic: 'i',
  underline: 'u',
  strike: 's',
  highlight: 'mark',
};

/** The document as editing HTML, one block per line. */
export function richDocumentToEditHtml(doc: RichDocument): string {
  return doc.content
    .map(blockHtml)
    .filter((html) => html !== '')
    .join('\n');
}

function blockHtml(block: RichBlock): string {
  switch (block.type) {
    case 'paragraph': {
      const inner = inlineHtml(block.content);
      return inner === '' ? '' : `<p>${inner}</p>`;
    }
    case 'heading':
      return `<h${block.attrs.level}>${inlineHtml(block.content)}</h${block.attrs.level}>`;
    case 'blockquote':
      return `<blockquote>${block.content.map(blockHtml).join('')}</blockquote>`;
    case 'bulletList':
    case 'orderedList': {
      const tag = block.type === 'bulletList' ? 'ul' : 'ol';
      return `<${tag}>${block.content.map((item) => `<li>${item.content.map(blockHtml).join('')}</li>`).join('')}</${tag}>`;
    }
    case 'horizontalRule':
      return '<hr>';
    case 'postMedia':
      return `<media ref="${block.attrs.ref}">${escapeHtml(block.attrs.caption?.trim() ?? '')}</media>`;
  }
}

function inlineHtml(content: RichInline[] | undefined): string {
  return (content ?? [])
    .map((node) => {
      if (node.type === 'hardBreak') return '<br>';
      let html = escapeHtml(node.text);
      // The first mark outermost, the order they are read back in.
      for (const mark of [...(node.marks ?? [])].reverse()) {
        html =
          mark.type === 'link'
            ? `<a href="${escapeHtml(mark.attrs.href).replace(/"/g, '&quot;')}">${html}</a>`
            : `<${MARK_TAGS[mark.type]}>${html}</${MARK_TAGS[mark.type]}>`;
      }
      return html;
    })
    .join('');
}

const INLINE_MARKS: Record<string, MarkName> = {
  b: 'bold',
  strong: 'bold',
  i: 'italic',
  em: 'italic',
  u: 'underline',
  ins: 'underline',
  s: 'strike',
  strike: 'strike',
  del: 'strike',
  mark: 'highlight',
};

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'hr', 'media', 'div', 'section', 'article', 'figure']);

/** Editing HTML back as a document: unknown wrappers are unwrapped, unknown inline tags kept as their text. */
export function editHtmlToRichDocument(html: string): RichDocument {
  const root = parse(html, { comment: false, blockTextElements: {} });
  const content = blocksOf(root.childNodes);
  return { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] };
}

/** Block nodes, with loose inline content between them gathered into paragraphs. */
function blocksOf(nodes: Node[]): RichBlock[] {
  const blocks: RichBlock[] = [];
  let loose: Node[] = [];
  const flush = () => {
    const paragraph = paragraphOf(loose);
    if (paragraph) blocks.push(paragraph);
    loose = [];
  };

  for (const node of nodes) {
    const tag = node instanceof HTMLElement ? node.rawTagName?.toLowerCase() : undefined;
    if (!tag || !BLOCK_TAGS.has(tag)) {
      loose.push(node);
      continue;
    }
    flush();
    const element = node as HTMLElement;
    switch (tag) {
      case 'p': {
        const paragraph = paragraphOf(element.childNodes);
        if (paragraph) blocks.push(paragraph);
        break;
      }
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const content = inlineOf(element.childNodes);
        if (content.length > 0) {
          blocks.push({ type: 'heading', attrs: { level: Math.min(Number(tag[1]), 3) as 1 | 2 | 3 }, content });
        }
        break;
      }
      case 'blockquote': {
        const inner = blocksOf(element.childNodes);
        if (inner.length > 0) blocks.push({ type: 'blockquote', content: inner });
        break;
      }
      case 'ul':
      case 'ol': {
        const items = element.childNodes
          .filter((child): child is HTMLElement => child instanceof HTMLElement && child.rawTagName?.toLowerCase() === 'li')
          .map((item) => blocksOf(item.childNodes))
          .filter((inner) => inner.length > 0)
          .map((inner) => ({ type: 'listItem' as const, content: inner }));
        if (items.length > 0) blocks.push({ type: tag === 'ul' ? 'bulletList' : 'orderedList', content: items });
        break;
      }
      case 'li':
        // A list item out of a list reads as its own lines.
        blocks.push(...blocksOf(element.childNodes));
        break;
      case 'hr':
        blocks.push({ type: 'horizontalRule' });
        break;
      case 'media': {
        const ref = element.getAttribute('ref')?.trim() ?? '';
        const caption = collapse(element.text).trim();
        blocks.push({ type: 'postMedia', attrs: { ref, caption: caption === '' ? null : caption } });
        break;
      }
      default:
        // A wrapper (div, section…): what is inside it.
        blocks.push(...blocksOf(element.childNodes));
    }
  }
  flush();
  return blocks;
}

function paragraphOf(nodes: Node[]): RichBlock | null {
  const content = inlineOf(nodes);
  return content.length > 0 ? { type: 'paragraph', content } : null;
}

/** Inline content: text with its marks, line breaks; whitespace as HTML reads it, trimmed at the edges. */
function inlineOf(nodes: Node[]): RichInline[] {
  const out: RichInline[] = [];
  const walk = (node: Node, marks: Mark[]) => {
    if (node.nodeType === NodeType.TEXT_NODE) {
      const text = collapse(node.text);
      if (text !== '') out.push(marks.length > 0 ? { type: 'text', text, marks: [...marks] } : { type: 'text', text });
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = node.rawTagName?.toLowerCase();
    if (tag === 'br') {
      out.push({ type: 'hardBreak' });
      return;
    }
    let next = marks;
    const mark = tag ? INLINE_MARKS[tag] : undefined;
    if (mark && !marks.some((existing) => existing.type === mark)) next = [...marks, { type: mark }];
    if (tag === 'a') {
      const href = node.getAttribute('href')?.trim() ?? '';
      if (/^https?:\/\/\S+$/i.test(href) && !marks.some((existing) => existing.type === 'link')) {
        next = [...next, { type: 'link', attrs: { href } }];
      }
    }
    for (const child of node.childNodes) walk(child, next);
  };
  for (const node of nodes) walk(node, []);
  return trimEdges(out);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** No space at the start or end of a block, or either side of a line break. */
function trimEdges(content: RichInline[]): RichInline[] {
  const trimmed = content.map((node, index) => {
    if (node.type !== 'text') return node;
    let text = node.text;
    if (index === 0 || content[index - 1]!.type === 'hardBreak') text = text.replace(/^ +/, '');
    if (index === content.length - 1 || content[index + 1]!.type === 'hardBreak') text = text.replace(/ +$/, '');
    return { ...node, text };
  });
  const kept = trimmed.filter((node) => node.type !== 'text' || node.text !== '');
  // Line breaks at the very edges carry nothing.
  while (kept[0]?.type === 'hardBreak') kept.shift();
  while (kept.at(-1)?.type === 'hardBreak') kept.pop();
  return kept;
}
