import { z } from 'zod';
import { escapeHtml } from '@/lib/telegram/format-caption';

/**
 * A post written in the editor: a Telegram rich message, with headings,
 * formatting and the post's own pictures between paragraphs.
 *
 * Stored as the editor's document (ProseMirror JSON, as Tiptap produces it),
 * and turned into Telegram's rich-message HTML here, on the server, when it
 * is published. The browser's word is never taken as HTML: the document is
 * checked against exactly the nodes and marks below, every bit of text is
 * escaped on the way out, and a link must be http(s). Whatever the editor
 * might produce beyond this is refused, not passed on.
 *
 * Media are the post's own, named by position — `m0` is its first photo or
 * video — or uploaded in the editor, named by their upload — `u12`
 * (src/lib/uploads/uploads.ts) — and sent with the message
 * (src/lib/sync/publish.ts).
 */

/** Telegram's limits for a rich message (Bot API, "Rich Message Limits"). */
export const RICH_TEXT_MAX = 32768;
export const RICH_BLOCKS_MAX = 500;
export const RICH_MEDIA_MAX = 50;
/** A caption under a picture: a line or two, not a second article. */
export const RICH_CAPTION_MAX = 1024;

const linkHref = z
  .string()
  .max(2048)
  .refine((href) => /^https?:\/\/[^\s]+$/i.test(href), 'links must be http(s)');

const markSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bold') }).strict(),
  z.object({ type: z.literal('italic') }).strict(),
  z.object({ type: z.literal('underline') }).strict(),
  z.object({ type: z.literal('strike') }).strict(),
  z.object({ type: z.literal('highlight') }).strict(),
  z
    .object({
      type: z.literal('link'),
      // The editor adds target/rel/class; only the address is kept.
      attrs: z.object({ href: linkHref }).passthrough(),
    })
    .strict(),
]);

const inlineSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1), marks: z.array(markSchema).max(6).optional() }).strict(),
  z.object({ type: z.literal('hardBreak'), marks: z.array(markSchema).optional() }).strict(),
]);

const inlineContent = z.array(inlineSchema).max(2000).optional();

/** A media reference: the post's media item at that position, or one of its uploads. */
export const MEDIA_REF = /^(m([0-9]|[1-4][0-9])|u[1-9][0-9]{0,9})$/;

/** What a reference's media is, for the HTML: the post's own by position, uploads by ref. */
export interface MediaKinds {
  own: ('photo' | 'video')[];
  uploads?: ReadonlyMap<string, 'photo' | 'video'>;
}

function kindOf(ref: string, kinds: MediaKinds): 'photo' | 'video' {
  return (ref.startsWith('u') ? kinds.uploads?.get(ref) : kinds.own[Number(ref.slice(1))]) ?? 'photo';
}

export type RichBlock =
  | { type: 'paragraph'; content?: RichInline[] }
  | { type: 'heading'; attrs: { level: 1 | 2 | 3 }; content?: RichInline[] }
  | { type: 'blockquote'; content: RichBlock[] }
  | { type: 'bulletList' | 'orderedList'; content: RichListItem[]; attrs?: Record<string, unknown> }
  | { type: 'horizontalRule' }
  | { type: 'postMedia'; attrs: { ref: string; caption?: string | null } };

export type RichListItem = { type: 'listItem'; content: RichBlock[] };
export type RichInline = z.infer<typeof inlineSchema>;
export type RichDocument = { type: 'doc'; content: RichBlock[] };

const blockSchema: z.ZodType<RichBlock> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('paragraph'), content: inlineContent, attrs: z.record(z.string(), z.unknown()).optional() }).strict(),
    z
      .object({
        type: z.literal('heading'),
        attrs: z.object({ level: z.union([z.literal(1), z.literal(2), z.literal(3)]) }).passthrough(),
        content: inlineContent,
      })
      .strict(),
    z.object({ type: z.literal('blockquote'), content: z.array(blockSchema).min(1).max(200) }).strict(),
    z
      .object({
        type: z.union([z.literal('bulletList'), z.literal('orderedList')]),
        content: z.array(listItemSchema).min(1).max(200),
        attrs: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
    z.object({ type: z.literal('horizontalRule') }).strict(),
    z
      .object({
        type: z.literal('postMedia'),
        attrs: z.object({ ref: z.string().regex(MEDIA_REF), caption: z.string().max(RICH_CAPTION_MAX).nullable().optional() }).strict(),
      })
      .strict(),
  ]) as z.ZodType<RichBlock>,
);

const listItemSchema: z.ZodType<RichListItem> = z.lazy(() =>
  z.object({ type: z.literal('listItem'), content: z.array(blockSchema).min(1).max(50) }).strict(),
);

export const richDocumentSchema: z.ZodType<RichDocument> = z
  .object({ type: z.literal('doc'), content: z.array(blockSchema).min(1).max(RICH_BLOCKS_MAX) })
  .strict();

/**
 * A document from the editor, checked: its shape, Telegram's limits, and that
 * every picture it places is one of the post's own `mediaCount` or one of
 * its `uploads`, at most once.
 */
export function parseRichDocument(
  value: unknown,
  options: { mediaCount: number; uploads?: ReadonlySet<string>; reservedChars?: number },
): { ok: true; doc: RichDocument } | { ok: false; error: string } {
  const parsed = richDocumentSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: 'The document has something the channel cannot show.' };
  const doc = parsed.data;

  const refs = mediaRefsOf(doc);
  if (refs.length > RICH_MEDIA_MAX) return { ok: false, error: `At most ${RICH_MEDIA_MAX} pictures.` };
  if (new Set(refs).size !== refs.length) return { ok: false, error: 'A picture can appear only once.' };
  const known = (ref: string) =>
    ref.startsWith('u') ? (options.uploads?.has(ref) ?? false) : Number(ref.slice(1)) < options.mediaCount;
  if (refs.some((ref) => !known(ref))) {
    return { ok: false, error: 'A picture that is not this post’s own.' };
  }

  if (countBlocks(doc.content) > RICH_BLOCKS_MAX) return { ok: false, error: `At most ${RICH_BLOCKS_MAX} blocks.` };
  const length = richDocumentPlainText(doc).length + (options.reservedChars ?? 0);
  if (length > RICH_TEXT_MAX) return { ok: false, error: `The text is ${length} characters; the limit is ${RICH_TEXT_MAX}.` };
  if (richDocumentPlainText(doc).trim() === '' && refs.length === 0) return { ok: false, error: 'The post is empty.' };

  return { ok: true, doc };
}

/** The media a document places, in order. */
export function mediaRefsOf(doc: RichDocument): string[] {
  const refs: string[] = [];
  const walk = (blocks: RichBlock[]) => {
    for (const block of blocks) {
      if (block.type === 'postMedia') refs.push(block.attrs.ref);
      else if (block.type === 'blockquote') walk(block.content);
      else if (block.type === 'bulletList' || block.type === 'orderedList') {
        for (const item of block.content) walk(item.content);
      }
    }
  };
  walk(doc.content);
  return refs;
}

function countBlocks(blocks: RichBlock[]): number {
  let count = 0;
  for (const block of blocks) {
    count += 1;
    if (block.type === 'blockquote') count += countBlocks(block.content);
    else if (block.type === 'bulletList' || block.type === 'orderedList') {
      for (const item of block.content) count += 1 + countBlocks(item.content);
    }
  }
  return count;
}

/** The words of a document, as a reader sees them — for limits, previews and search. */
export function richDocumentPlainText(doc: RichDocument): string {
  const lines: string[] = [];
  const walk = (blocks: RichBlock[]) => {
    for (const block of blocks) {
      if (block.type === 'paragraph' || block.type === 'heading') lines.push(inlineText(block.content));
      else if (block.type === 'blockquote') walk(block.content);
      else if (block.type === 'bulletList' || block.type === 'orderedList') {
        for (const item of block.content) walk(item.content);
      } else if (block.type === 'postMedia' && block.attrs.caption) lines.push(block.attrs.caption);
    }
  };
  walk(doc.content);
  return lines.filter((line) => line !== '').join('\n\n');
}

function inlineText(content: RichInline[] | undefined): string {
  return (content ?? []).map((node) => (node.type === 'text' ? node.text : '\n')).join('');
}

/**
 * Telegram rich-message HTML for a document. Media become
 * `tg://photo?id=m0` / `tg://video?id=m1`, sent alongside under those ids; the
 * channel's footer, already Telegram HTML, closes the post.
 */
export function richDocumentToHtml(
  doc: RichDocument,
  options: { mediaKinds: MediaKinds; footerHtml?: string | null },
): string {
  // An empty paragraph — the editor keeps one at the end to type into — is not sent.
  const out = doc.content.map((block) => blockHtml(block, options.mediaKinds)).filter((html) => html !== '<p></p>');
  if (options.footerHtml) out.push(`<p>${options.footerHtml}</p>`);
  return out.join('');
}

function blockHtml(block: RichBlock, kinds: MediaKinds): string {
  switch (block.type) {
    case 'paragraph':
      return `<p>${inlineHtml(block.content)}</p>`;
    case 'heading':
      return `<h${block.attrs.level}>${inlineHtml(block.content)}</h${block.attrs.level}>`;
    case 'blockquote':
      // Telegram's quotation holds text, line by line, not blocks.
      return `<blockquote>${quoteLines(block.content).join('<br/>')}</blockquote>`;
    case 'bulletList':
    case 'orderedList': {
      const tag = block.type === 'bulletList' ? 'ul' : 'ol';
      const items = block.content.map((item) => `<li>${item.content.map((inner) => listItemBlockHtml(inner, kinds)).join('')}</li>`);
      return `<${tag}>${items.join('')}</${tag}>`;
    }
    case 'horizontalRule':
      return '<hr/>';
    case 'postMedia': {
      const kind = kindOf(block.attrs.ref, kinds);
      const element =
        kind === 'video'
          ? `<video src="tg://video?id=${block.attrs.ref}"></video>`
          : `<img src="tg://photo?id=${block.attrs.ref}"/>`;
      const caption = block.attrs.caption?.trim();
      return caption ? `<figure>${element}<figcaption>${escapeHtml(caption)}</figcaption></figure>` : element;
    }
  }
}

/** A quotation's lines: its paragraphs' text with their formatting, anything else as plain words. */
function quoteLines(blocks: RichBlock[]): string[] {
  return blocks.flatMap((block) => {
    if (block.type === 'paragraph' || block.type === 'heading') return [inlineHtml(block.content)];
    if (block.type === 'blockquote') return quoteLines(block.content);
    if (block.type === 'bulletList' || block.type === 'orderedList') {
      return block.content.flatMap((item) => quoteLines(item.content));
    }
    return [];
  });
}

/** A list item's paragraph is its line, not a block of its own. */
function listItemBlockHtml(block: RichBlock, kinds: MediaKinds): string {
  return block.type === 'paragraph' ? inlineHtml(block.content) : blockHtml(block, kinds);
}

const MARK_TAGS: Record<'bold' | 'italic' | 'underline' | 'strike' | 'highlight', string> = {
  bold: 'b',
  italic: 'i',
  underline: 'u',
  strike: 's',
  highlight: 'mark',
};

function inlineHtml(content: RichInline[] | undefined): string {
  return (content ?? [])
    .map((node) => {
      if (node.type === 'hardBreak') return '<br/>';
      let html = escapeHtml(node.text);
      for (const mark of node.marks ?? []) {
        if (mark.type === 'link') html = `<a href="${escapeAttribute(mark.attrs.href)}">${html}</a>`;
        else html = `<${MARK_TAGS[mark.type]}>${html}</${MARK_TAGS[mark.type]}>`;
      }
      return html;
    })
    .join('');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

/**
 * Where the editor starts for a post never opened in it: its pictures first,
 * as they are in the post now, then its text — a paragraph per blank-line
 * break, a line break per newline.
 */
export function initialRichDocument(input: { text: string; mediaCount: number }): RichDocument {
  const media: RichBlock[] = Array.from({ length: Math.min(input.mediaCount, RICH_MEDIA_MAX) }, (_, index) => ({
    type: 'postMedia',
    attrs: { ref: `m${index}`, caption: null },
  }));
  const paragraphs: RichBlock[] = input.text
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== '')
    .map((chunk) => ({
      type: 'paragraph',
      content: chunk.split('\n').flatMap((line, index): RichInline[] => [
        ...(index > 0 ? [{ type: 'hardBreak' as const }] : []),
        ...(line ? [{ type: 'text' as const, text: line }] : []),
      ]),
    }));
  const content = [...media, ...paragraphs];
  return { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] };
}
