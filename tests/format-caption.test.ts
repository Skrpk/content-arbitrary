import { describe, expect, it } from 'vitest';
import {
  buildSourceLine,
  composePlainText,
  escapeHtml,
  formatCaption,
  truncateForDisplay,
  truncateToLength,
} from '@/lib/telegram/format-caption';
import { TELEGRAM_CAPTION_LIMIT, TELEGRAM_MESSAGE_TEXT_LIMIT } from '@/lib/telegram/limits';

const base = {
  username: 'someaccount',
  postId: '1234567890123456789',
  includeSourceLink: true,
};

describe('escapeHtml', () => {
  it('escapes exactly the three characters Telegram treats as markup', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('leaves characters that MarkdownV2 would require escaping untouched', () => {
    const text = 'Cost: $5.00 (50% off!) _really_ *now* [link] #tag';
    expect(escapeHtml(text)).toBe(text);
  });
});

describe('buildSourceLine', () => {
  it('builds the canonical x.com permalink', () => {
    expect(buildSourceLine('someaccount', '123')).toBe('Source: https://x.com/someaccount/status/123');
  });

  it('tolerates a leading @ in the handle', () => {
    expect(buildSourceLine('@someaccount', '123')).toBe('Source: https://x.com/someaccount/status/123');
  });
});

describe('composePlainText', () => {
  it('produces a clean post: text, blank line, source line', () => {
    const result = composePlainText({ ...base, text: 'Hello world' });
    expect(result).toBe('Hello world\n\nSource: https://x.com/someaccount/status/1234567890123456789');
  });

  it('omits the source line when INCLUDE_SOURCE_LINK is off', () => {
    const result = composePlainText({ ...base, text: 'Hello world', includeSourceLink: false });
    expect(result).toBe('Hello world');
  });

  it('adds no service text of its own', () => {
    const result = composePlainText({ ...base, text: 'Hello', includeSourceLink: false });
    expect(result).toBe('Hello');
  });

  it('applies prefix and suffix in order', () => {
    const result = composePlainText({
      ...base,
      text: 'Body',
      includeSourceLink: false,
      prefix: 'PREFIX',
      suffix: 'SUFFIX',
    });
    expect(result).toBe('PREFIX\n\nBody\n\nSUFFIX');
  });

  it('handles an empty post text (media-only post)', () => {
    const result = composePlainText({ ...base, text: '' });
    expect(result).toBe('Source: https://x.com/someaccount/status/1234567890123456789');
  });
});

describe('truncateToLength', () => {
  it('returns short strings unchanged', () => {
    expect(truncateToLength('hello', 10)).toBe('hello');
  });

  it('never splits a surrogate pair', () => {
    // Each of these emoji is 2 UTF-16 code units.
    const text = '😀😀😀';
    const result = truncateToLength(text, 5);
    expect(result).toBe('😀😀');
    expect(result).not.toContain('�');
    expect([...result]).toHaveLength(2);
  });

  it('keeps a ZWJ emoji sequence intact rather than tearing it apart', () => {
    const family = '👨‍👩‍👧‍👦';
    const result = truncateToLength(`${family}${family}`, family.length + 3);
    expect(result).toBe(family);
  });

  it('keeps a flag emoji intact', () => {
    const flag = '🇺🇦';
    expect(truncateToLength(`${flag}${flag}`, 5)).toBe(flag);
  });

  it('keeps combining marks attached to their base character', () => {
    const combined = 'é';
    const result = truncateToLength(`abc${combined}`, 4);
    expect(result).toBe('abc');
  });
});

describe('truncateForDisplay', () => {
  it('appends an ellipsis and respects the limit', () => {
    const result = truncateForDisplay('a'.repeat(100), 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result.endsWith('…')).toBe(true);
  });

  it('breaks on a word boundary rather than mid-word', () => {
    const source = 'the quick brown fox jumps over the lazy dog';
    const result = truncateForDisplay(source, 24);

    expect(result.endsWith('…')).toBe(true);

    // The retained text must be a whole-word prefix of the original.
    const body = result.slice(0, -1);
    expect(source.startsWith(body)).toBe(true);
    const nextChar = source.charAt(body.length);
    expect(nextChar === '' || nextChar === ' ').toBe(true);
  });
});

describe('formatCaption', () => {
  it('uses the full text when it fits the caption limit', () => {
    const result = formatCaption({ ...base, text: 'A short post' });
    expect(result.truncated).toBe(false);
    expect(result.overflowMessage).toBeUndefined();
    expect(result.caption).toBe(
      'A short post\n\nSource: https://x.com/someaccount/status/1234567890123456789',
    );
  });

  it('escapes HTML in the post text', () => {
    const result = formatCaption({ ...base, text: '5 < 10 & rising', includeSourceLink: false });
    expect(result.caption).toBe('5 &lt; 10 &amp; rising');
  });

  it('splits into caption + overflow message when the text is too long', () => {
    const long = 'word '.repeat(400).trim();
    const result = formatCaption({ ...base, text: long });

    expect(result.truncated).toBe(true);
    expect(result.caption.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
    expect(result.overflowMessage).toBeDefined();
    expect(result.overflowMessage!.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_TEXT_LIMIT);
  });

  it('keeps the source link in the short caption when truncating', () => {
    const long = 'word '.repeat(400).trim();
    const result = formatCaption({ ...base, text: long });
    expect(result.caption).toContain('Source: https://x.com/someaccount/status/1234567890123456789');
  });

  it('clamps the overflow message to the sendMessage limit', () => {
    const enormous = 'x'.repeat(20_000);
    const result = formatCaption({ ...base, text: enormous });
    expect(result.overflowMessage!.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_TEXT_LIMIT);
  });

  it('does not produce a broken caption for emoji-heavy long text', () => {
    const result = formatCaption({ ...base, text: '🎉'.repeat(2000) });
    expect(result.caption.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
    expect(result.caption).not.toContain('�');
  });
});
