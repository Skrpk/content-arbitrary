import { describe, expect, it } from 'vitest';
import { parseRichDocument, type RichDocument } from '@/lib/rich/document';
import { editHtmlToRichDocument, richDocumentToEditHtml } from '@/lib/rich/edit-html';

const doc: RichDocument = {
  type: 'doc',
  content: [
    { type: 'postMedia', attrs: { ref: 'm0', caption: 'Mars at dawn' } },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'A dawn on Mars' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Curiosity saw ' },
        { type: 'text', text: 'blue', marks: [{ type: 'bold' }, { type: 'italic' }] },
        { type: 'text', text: ' light' },
        { type: 'hardBreak' },
        { type: 'text', text: 'NASA', marks: [{ type: 'link', attrs: { href: 'https://nasa.gov/a?b=1&c=2' } }] },
      ],
    },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one <two>' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'three', marks: [{ type: 'highlight' }] }] }] },
      ],
    },
    { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quoted' }] }] },
    { type: 'horizontalRule' },
    { type: 'postMedia', attrs: { ref: 'm1', caption: null } },
    // The editor's empty last paragraph is not shown.
    { type: 'paragraph' },
  ],
};

describe('the editing HTML', () => {
  it('writes the document as the small HTML the assistant reads, escaped', () => {
    const html = richDocumentToEditHtml(doc);
    expect(html.split('\n')).toEqual([
      '<media ref="m0">Mars at dawn</media>',
      '<h2>A dawn on Mars</h2>',
      '<p>Curiosity saw <b><i>blue</i></b> light<br><a href="https://nasa.gov/a?b=1&amp;c=2">NASA</a></p>',
      '<ul><li><p>one &lt;two&gt;</p></li><li><p><mark>three</mark></p></li></ul>',
      '<blockquote><p>Quoted</p></blockquote>',
      '<hr>',
      '<media ref="m1"></media>',
    ]);
  });

  it('reads its own output back as the same document', () => {
    const back = editHtmlToRichDocument(richDocumentToEditHtml(doc));
    expect(back).toEqual({ ...doc, content: doc.content.slice(0, -1) });
    expect(parseRichDocument(back, { mediaCount: 2 }).ok).toBe(true);
  });

  it('is lenient about what a model writes around it', () => {
    const back = editHtmlToRichDocument(
      `Loose line first
<div><p>  Spaced
   <strong>out</strong>   text </p></div>
<h5>Small</h5>
<p><em>a</em> <span>plain</span> <a href="javascript:alert(1)">bad link</a> <font>kept</font></p>
<li>stray item</li>
<p></p>`,
    );
    expect(back.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Loose line first' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Spaced ' },
          { type: 'text', text: 'out', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' text' },
        ],
      },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Small' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'a', marks: [{ type: 'italic' }] },
          { type: 'text', text: ' ' },
          { type: 'text', text: 'plain' },
          { type: 'text', text: ' ' },
          { type: 'text', text: 'bad link' },
          { type: 'text', text: ' ' },
          { type: 'text', text: 'kept' },
        ],
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'stray item' }] },
    ]);
  });

  it('decodes entities, and leaves a picture that is not the post’s for the document check to refuse', () => {
    const back = editHtmlToRichDocument('<p>Tom &amp; Jerry &lt;3 &quot;hi&quot;</p><media ref="m7">x</media>');
    expect(back.content[0]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'Tom & Jerry <3 "hi"' }] });
    expect(parseRichDocument(back, { mediaCount: 1 })).toEqual({ ok: false, error: 'A picture that is not this post’s own.' });
  });

  it('gives an empty document one empty paragraph, as the editor keeps', () => {
    expect(editHtmlToRichDocument('   ')).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
  });
});
