import { describe, expect, it } from 'vitest';
import { formatCaption, formatTextPost } from '@/lib/telegram/format-caption';
import { TELEGRAM_CAPTION_LIMIT, TELEGRAM_MESSAGE_TEXT_LIMIT } from '@/lib/telegram/limits';
import {
  captionToPlainText,
  parsePostFooter,
  POST_FOOTER_MAX,
  stripFooter,
  withFooter,
} from '@/lib/telegram/post-footer';

const VECTOR = '[ВЕКТОР | космос · футуризм · sci-fi](https://t.me/vector_space2035)';

describe('parsing a post footer', () => {
  it('turns a Markdown-style link into a Telegram link', () => {
    expect(parsePostFooter(VECTOR)).toEqual({
      html: '<a href="https://t.me/vector_space2035">ВЕКТОР | космос · футуризм · sci-fi</a>',
      text: 'ВЕКТОР | космос · футуризм · sci-fi',
    });
  });

  it('links part of a line, and escapes all the rest', () => {
    expect(parsePostFooter('  Підписуйтесь: [ВЕКТОР](https://t.me/v) <3 & more  ')).toEqual({
      html: 'Підписуйтесь: <a href="https://t.me/v">ВЕКТОР</a> &lt;3 &amp; more',
      text: 'Підписуйтесь: ВЕКТОР <3 & more',
    });
  });

  it('never lets a link carry markup or anything but a web or tg link', () => {
    expect(parsePostFooter('[x](javascript:alert(1))')).toEqual({
      html: '[x](javascript:alert(1))',
      text: '[x](javascript:alert(1))',
    });
    expect(parsePostFooter('[<b>x</b>](https://t.me/v?a="b"&c)')!.html).toBe(
      '<a href="https://t.me/v?a=&quot;b&quot;&amp;c">&lt;b&gt;x&lt;/b&gt;</a>',
    );
  });

  it('is nothing when unset, blank or too long to be a footer', () => {
    expect(parsePostFooter(null)).toBeNull();
    expect(parsePostFooter('   ')).toBeNull();
    expect(parsePostFooter('a'.repeat(POST_FOOTER_MAX + 1))).toBeNull();
    expect(parsePostFooter('a'.repeat(POST_FOOTER_MAX))).not.toBeNull();
  });
});

describe('a caption with a footer', () => {
  const footer = parsePostFooter(VECTOR)!;
  const base = { username: 'nasa', postId: '1', includeSourceLink: false };

  it('ends with the footer, a blank line below the text', () => {
    const { caption } = formatCaption({ ...base, text: 'Марс & Місяць', footer });

    expect(caption).toBe(`Марс &amp; Місяць\n\n${footer.html}`);
    expect(captionToPlainText(caption)).toBe('Марс & Місяць\n\nВЕКТОР | космос · футуризм · sci-fi');
  });

  it('comes last, after the source line', () => {
    const { caption } = formatCaption({ ...base, includeSourceLink: true, text: 'Марс', footer });

    expect(caption.endsWith(footer.html)).toBe(true);
    expect(caption.indexOf('Source:')).toBeLessThan(caption.indexOf('<a href'));
  });

  it('is never cut: a long post is shortened to leave room for it, in the caption and the follow-up', () => {
    const { caption, overflowMessage } = formatCaption({ ...base, text: 'слово '.repeat(1000), footer });

    expect(caption.endsWith(footer.html)).toBe(true);
    expect(captionToPlainText(caption).length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
    expect(overflowMessage!.endsWith(footer.html)).toBe(true);
    expect(captionToPlainText(overflowMessage!).length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_TEXT_LIMIT);
  });

  it('counts only what a reader sees against the limit, not the link markup', () => {
    const fits = 'а'.repeat(TELEGRAM_CAPTION_LIMIT - footer.text.length - 2);
    expect(formatCaption({ ...base, text: fits, footer }).truncated).toBe(false);
    expect(formatCaption({ ...base, text: `${fits}а`, footer }).truncated).toBe(true);
  });

  it('goes under a text-only post too', () => {
    const text = formatTextPost({ ...base, text: 'слово '.repeat(2000), footer });

    expect(text.endsWith(footer.html)).toBe(true);
    expect(captionToPlainText(text).length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_TEXT_LIMIT);
  });

  it('changes nothing without one', () => {
    expect(formatCaption({ ...base, text: 'Марс', footer: null }).caption).toBe('Марс');
  });
});

describe('splitting the footer off for the editor', () => {
  const footer = parsePostFooter(VECTOR)!;

  it('gives back the text above it', () => {
    expect(stripFooter(withFooter('Марс &amp; Місяць', footer), footer)).toBe('Марс &amp; Місяць');
    expect(stripFooter(footer.html, footer)).toBe('');
  });

  it('finds nothing to split off a caption made before this footer', () => {
    expect(stripFooter('Марс', footer)).toBeNull();
    expect(stripFooter(withFooter('Марс', parsePostFooter('[Old](https://t.me/old)')), footer)).toBeNull();
    expect(stripFooter('Марс', null)).toBeNull();
  });
});
