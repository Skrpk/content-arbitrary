import { describe, expect, it } from 'vitest';
import {
  initialRichDocument,
  mediaRefsOf,
  parseRichDocument,
  richDocumentPlainText,
  richDocumentToHtml,
  type RichDocument,
} from '@/lib/rich/document';

const text = (value: string, marks?: { type: string; attrs?: Record<string, unknown> }[]) => ({
  type: 'text',
  text: value,
  ...(marks ? { marks } : {}),
});

/** A document as the editor sends it — Tiptap's JSON, with the attributes it adds. */
const editorDoc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [text('Webb & the <planet>')] },
    { type: 'postMedia', attrs: { ref: 'm1', caption: 'Caption "quoted" <b>not bold</b>' } },
    {
      type: 'paragraph',
      content: [
        text('Bold', [{ type: 'bold' }]),
        text(' and '),
        text('a link', [{ type: 'link', attrs: { href: 'https://esa.int/?a=1&b=2', target: '_blank', rel: 'noopener', class: null } }]),
        { type: 'hardBreak' },
        text('marked', [{ type: 'highlight' }, { type: 'italic' }]),
      ],
    },
    { type: 'blockquote', content: [{ type: 'paragraph', content: [text('One')] }, { type: 'paragraph', content: [text('Two')] }] },
    {
      type: 'orderedList',
      attrs: { start: 1, type: null },
      content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [text('First')] }] }],
    },
    { type: 'horizontalRule' },
    { type: 'postMedia', attrs: { ref: 'm0', caption: null } },
    { type: 'paragraph' },
  ],
};

describe('a document from the editor', () => {
  it('is accepted as Tiptap sends it', () => {
    const parsed = parseRichDocument(editorDoc, { mediaCount: 2 });
    expect(parsed.ok).toBe(true);
    expect(mediaRefsOf((parsed as { doc: RichDocument }).doc)).toEqual(['m1', 'm0']);
  });

  it('becomes Telegram rich HTML with every bit of text escaped', () => {
    const parsed = parseRichDocument(editorDoc, { mediaCount: 2 }) as { ok: true; doc: RichDocument };
    expect(richDocumentToHtml(parsed.doc, { mediaKinds: { own: ['photo', 'video'] }, footerHtml: '<a href="https://t.me/x">X</a>' })).toBe(
      '<h1>Webb &amp; the &lt;planet&gt;</h1>' +
        '<figure><video src="tg://video?id=m1"></video><figcaption>Caption "quoted" &lt;b&gt;not bold&lt;/b&gt;</figcaption></figure>' +
        '<p><b>Bold</b> and <a href="https://esa.int/?a=1&amp;b=2">a link</a><br/><i><mark>marked</mark></i></p>' +
        '<blockquote>One<br/>Two</blockquote>' +
        '<ol><li>First</li></ol>' +
        '<hr/>' +
        '<img src="tg://photo?id=m0"/>' +
        '<p><a href="https://t.me/x">X</a></p>',
    );
  });

  it('refuses what a channel cannot show, or what the browser should not get to say', () => {
    const withBlock = (block: unknown) => ({ type: 'doc', content: [block] });
    const refused = [
      withBlock({ type: 'codeBlock', content: [text('x')] }),
      withBlock({ type: 'paragraph', content: [text('x', [{ type: 'code' }])] }),
      withBlock({ type: 'paragraph', content: [text('x', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }])] }),
      withBlock({ type: 'heading', attrs: { level: 5 }, content: [text('x')] }),
      withBlock({ type: 'paragraph', content: [{ type: 'html', html: '<script>' }] }),
      { type: 'doc', content: [] },
    ];
    for (const doc of refused) expect(parseRichDocument(doc, { mediaCount: 0 }).ok).toBe(false);
  });

  it('places only the post’s own pictures, each once', () => {
    const media = (ref: string) => ({ type: 'postMedia', attrs: { ref, caption: null } });
    expect(parseRichDocument({ type: 'doc', content: [media('m2')] }, { mediaCount: 2 })).toMatchObject({ ok: false });
    expect(parseRichDocument({ type: 'doc', content: [media('m0'), media('m0')] }, { mediaCount: 2 })).toMatchObject({ ok: false });
    expect(parseRichDocument({ type: 'doc', content: [media('../etc')] }, { mediaCount: 2 })).toMatchObject({ ok: false });
  });

  it('places the post’s own uploads too, as uploads, and no one else’s', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'postMedia', attrs: { ref: 'u12', caption: null } },
        { type: 'postMedia', attrs: { ref: 'm0', caption: 'Own' } },
      ],
    };
    expect(parseRichDocument(doc, { mediaCount: 1, uploads: new Set(['u12']) }).ok).toBe(true);
    expect(parseRichDocument(doc, { mediaCount: 1, uploads: new Set(['u13']) })).toEqual({
      ok: false,
      error: 'A picture that is not this post’s own.',
    });
    expect(parseRichDocument(doc, { mediaCount: 1 }).ok).toBe(false);
    const parsed = parseRichDocument(doc, { mediaCount: 1, uploads: new Set(['u12']) });
    expect(
      richDocumentToHtml(parsed.ok ? parsed.doc : (doc as never), {
        mediaKinds: { own: ['photo'], uploads: new Map([['u12', 'video']]) },
      }),
    ).toBe('<video src="tg://video?id=u12"></video><figure><img src="tg://photo?id=m0"/><figcaption>Own</figcaption></figure>');
  });

  it('holds to Telegram’s length, counting the footer it will carry', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [text('a'.repeat(32760))] }] };
    expect(parseRichDocument(doc, { mediaCount: 0 }).ok).toBe(true);
    expect(parseRichDocument(doc, { mediaCount: 0, reservedChars: 20 })).toMatchObject({ ok: false });
  });

  it('refuses an empty post', () => {
    expect(parseRichDocument({ type: 'doc', content: [{ type: 'paragraph' }] }, { mediaCount: 0 }).ok).toBe(false);
  });
});

describe('a post opened in the editor for the first time', () => {
  it('starts with its pictures, then its text — a paragraph per blank line, a break per newline', () => {
    const doc = initialRichDocument({ text: 'First line\nsecond line\n\nNext paragraph', mediaCount: 2 });
    expect(doc.content.map((block) => block.type)).toEqual(['postMedia', 'postMedia', 'paragraph', 'paragraph']);
    expect(richDocumentPlainText(doc)).toBe('First line\nsecond line\n\nNext paragraph');
    expect(parseRichDocument(doc, { mediaCount: 2 }).ok).toBe(true);
  });
});
