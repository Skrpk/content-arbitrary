import { describe, expect, it } from 'vitest';
import { normalizeXUsername } from '@/lib/sources/normalize';
import { parseCommand } from '@/lib/telegram/commands';

describe('normalizeXUsername', () => {
  it.each([
    ['karpathy', 'bare handle'],
    ['@karpathy', 'with @'],
    ['  @karpathy  ', 'with surrounding space'],
    ['https://x.com/karpathy', 'profile URL'],
    ['http://x.com/karpathy', 'http URL'],
    ['https://www.x.com/karpathy', 'www URL'],
    ['https://mobile.twitter.com/karpathy', 'mobile twitter URL'],
    ['https://twitter.com/karpathy', 'legacy twitter URL'],
    ['x.com/karpathy', 'URL without scheme'],
    ['https://x.com/karpathy/', 'trailing slash'],
    ['https://x.com/karpathy?s=20', 'tracking query'],
    ['https://x.com/karpathy/status/123', 'link to a post'],
    ['@@karpathy', 'doubled @'],
  ])('normalizes %s (%s) to karpathy', (input) => {
    expect(normalizeXUsername(input)).toEqual({ ok: true, username: 'karpathy' });
  });

  it('preserves the handle exactly, including case and underscores', () => {
    expect(normalizeXUsername('@Trail_Cams')).toEqual({ ok: true, username: 'Trail_Cams' });
  });

  it('accepts the maximum handle length', () => {
    const handle = 'a'.repeat(15);
    expect(normalizeXUsername(handle)).toEqual({ ok: true, username: handle });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace only'],
  ])('rejects %s input (%s)', (input) => {
    expect(normalizeXUsername(input)).toEqual({ ok: false, reason: 'empty' });
  });

  it.each([
    ['a'.repeat(16), 'too long'],
    ['has spaces', 'contains a space'],
    ['bad-handle', 'contains a hyphen'],
    ['emoji🎉', 'contains an emoji'],
    ['https://example.com/karpathy', 'a link to another site'],
  ])('rejects %s (%s)', (input) => {
    expect(normalizeXUsername(input)).toEqual({ ok: false, reason: 'invalid' });
  });

  it.each([['https://x.com/home'], ['https://x.com/i/status/1'], ['@settings']])(
    'rejects the x.com page %s',
    (input) => {
      expect(normalizeXUsername(input)).toEqual({ ok: false, reason: 'reserved' });
    },
  );
});

describe('parseCommand', () => {
  it('parses a command with an argument', () => {
    expect(parseCommand('/addsource @karpathy')).toEqual({
      command: 'addsource',
      args: '@karpathy',
    });
  });

  it('parses a command with no argument', () => {
    expect(parseCommand('/sources')).toEqual({ command: 'sources', args: '' });
  });

  it('lowercases the command but leaves the argument alone', () => {
    expect(parseCommand('/AddSource @Trail_Cams')).toEqual({
      command: 'addsource',
      args: '@Trail_Cams',
    });
  });

  it('accepts the @botname suffix Telegram adds in groups', () => {
    expect(parseCommand('/sources@my_mirror_bot')).toEqual({ command: 'sources', args: '' });
  });

  it('tolerates extra whitespace', () => {
    expect(parseCommand('  /addsource    karpathy  ')).toEqual({
      command: 'addsource',
      args: 'karpathy',
    });
  });

  it.each([['hello'], ['not a command'], ['']])('returns null for non-command %s', (text) => {
    expect(parseCommand(text)).toBeNull();
  });

  it('returns null for undefined text', () => {
    expect(parseCommand(undefined)).toBeNull();
  });
});
