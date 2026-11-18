import { describe, expect, it, vi } from 'vitest';
import { createContainer } from '@/lib/threads/client';
import { buildApprovalKeyboard, parseCallbackData, targetsOfApproval } from '@/lib/sync/approval';
import { allowedTargets, normalizeTargets, publishedLine } from '@/lib/publish/targets';
import { autoPublishedThreadsContent, threadsTextFromTelegram } from '@/lib/threads/deliveries';
import { parsePostFooter, withFooter } from '@/lib/telegram/post-footer';
import type { RichDocument } from '@/lib/rich/document';
import { cutForThreads, normalizeTopicTag, telegramHtmlToText, threadsLength, threadsTextFor, THREADS_TEXT_LIMIT } from '@/lib/threads/text';

/** Choosing where a post goes, and its text as Threads takes it. */

describe('Threads’ length', () => {
  it('counts a character each, an emoji as its bytes', () => {
    expect(threadsLength('Привіт')).toBe(6);
    expect(threadsLength('🔭')).toBe(4);
    expect(threadsLength('👩‍🚀')).toBe(Buffer.byteLength('👩‍🚀'));
  });

  it('keeps a short text whole, with no attachment', () => {
    expect(threadsTextFor('  Webb finds water.  ', false)).toEqual({ text: 'Webb finds water.', attachment: null });
  });

  it('carries a long text-only post whole as an attachment, under a first part that fits', () => {
    const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} about the telescope.`).join(' ');
    const result = threadsTextFor(long, false);
    expect(threadsLength(result.text)).toBeLessThanOrEqual(THREADS_TEXT_LIMIT);
    expect(result.text.endsWith('…')).toBe(true);
    expect(result.attachment).toBe(long);
  });

  it('cuts a long post with media, which cannot carry an attachment', () => {
    const long = '🚀 '.repeat(400);
    const result = threadsTextFor(long, true);
    expect(result.attachment).toBeNull();
    expect(threadsLength(result.text)).toBeLessThanOrEqual(THREADS_TEXT_LIMIT);
  });

  it('cuts at a sentence when one ends near the limit', () => {
    const text = `${'a'.repeat(300)}. ${'b '.repeat(200)}`;
    expect(cutForThreads(text)).toBe(`${'a'.repeat(300)}.…`);
  });
});

describe('a caption as plain text', () => {
  it('drops the formatting and keeps the address a link hides', () => {
    expect(telegramHtmlToText('<b>Webb</b> finds water\n\n<a href="https://example.com/a?x=1&amp;y=2">Read more</a>')).toBe(
      'Webb finds water\n\nRead more (https://example.com/a?x=1&y=2)',
    );
    expect(telegramHtmlToText('<a href="https://example.com">https://example.com</a>')).toBe('https://example.com');
  });
});

describe('where a post goes', () => {
  it('is Telegram for a post decided with no choice', () => {
    expect(normalizeTargets(null)).toEqual(['telegram']);
    expect(normalizeTargets([])).toEqual(['telegram']);
    expect(normalizeTargets(['threads', 'telegram', 'threads'])).toEqual(['telegram', 'threads']);
  });

  it('includes Threads only for a channel with an account', () => {
    expect(allowedTargets(['threads'], false)).toBeNull();
    expect(allowedTargets(['telegram', 'threads'], true)).toEqual(['telegram', 'threads']);
    expect(allowedTargets(['telegram'], false)).toEqual(['telegram']);
  });

  it('says where it went', () => {
    expect(publishedLine(['telegram'])).toBe('✅ Published');
    expect(publishedLine(['telegram', 'threads'])).toContain('Threads');
  });
});

describe('the review buttons of a channel with Threads', () => {
  it('are three Approves — Telegram, Threads, both — with Reject below', () => {
    const keyboard = buildApprovalKeyboard(42, { threads: true });
    expect(keyboard.inline_keyboard[0]!.map((button) => button.text)).toEqual(['✅ Telegram', '✅ Threads', '✅ Both']);
    expect(keyboard.inline_keyboard[1]!.map((button) => button.text)).toEqual(['🚫 Reject']);
  });

  it('stay Approve and Reject without Threads', () => {
    expect(buildApprovalKeyboard(42).inline_keyboard[0]!.map((button) => button.text)).toEqual(['✅ Approve', '🚫 Reject']);
  });

  it('say where to in their callback', () => {
    for (const [data, targets] of [
      ['at:42', ['telegram']],
      ['ah:42', ['threads']],
      ['ab:42', ['telegram', 'threads']],
    ] as const) {
      const parsed = parseCallbackData(data);
      expect(parsed?.postId).toBe(42);
      expect(parsed && parsed.action !== 'reject_reason' ? targetsOfApproval(parsed.action) : 'unparsed').toEqual(targets);
    }
    expect(targetsOfApproval('approve')).toBeNull();
  });
});

describe('a channel’s Threads topic', () => {
  it('is taken as typed, a leading # and outer spaces dropped, and empty as none', () => {
    expect(normalizeTopicTag('Wildlife')).toEqual({ ok: true, tag: 'Wildlife' });
    expect(normalizeTopicTag('  #Wildlife photography ')).toEqual({ ok: true, tag: 'Wildlife photography' });
    expect(normalizeTopicTag('   ')).toEqual({ ok: true, tag: null });
    expect(normalizeTopicTag('#')).toEqual({ ok: true, tag: null });
  });

  it('is refused as Threads would refuse it', () => {
    expect(normalizeTopicTag('a'.repeat(50))).toEqual({ ok: true, tag: 'a'.repeat(50) });
    expect(normalizeTopicTag('a'.repeat(51)).ok).toBe(false);
    expect(normalizeTopicTag('Nature.Wildlife').ok).toBe(false);
    expect(normalizeTopicTag('Nature & Wildlife').ok).toBe(false);
  });

  it('goes on the container that is published, never on a carousel item', async () => {
    const sent: URLSearchParams[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent.push(init!.body as URLSearchParams);
      return new Response(JSON.stringify({ id: '1' }), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const who = { threadsUserId: '42', token: 't' };

    await createContainer(who, { mediaType: 'IMAGE', imageUrl: 'https://x/a.jpg', topicTag: 'Wildlife' }, { fetchImpl });
    await createContainer(who, { mediaType: 'IMAGE', imageUrl: 'https://x/b.jpg', carouselItem: true, topicTag: 'Wildlife' }, { fetchImpl });
    await createContainer(who, { mediaType: 'CAROUSEL', children: ['1', '2'], topicTag: 'Wildlife' }, { fetchImpl });
    await createContainer(who, { mediaType: 'TEXT', text: 'hi', topicTag: null }, { fetchImpl });

    expect(sent.map((body) => body.get('topic_tag'))).toEqual(['Wildlife', null, 'Wildlife', null]);
  });
});

describe('the channel’s footer on Threads', () => {
  const footer = parsePostFooter('[ВЕКТОР | космос · футуризм · sci-fi](https://t.me/vector)')!;
  const withIt = withFooter('Людина зі штучними органами', footer);

  it('is left out of a post’s caption and of its overflow', () => {
    expect(threadsTextFromTelegram({ richDoc: null, caption: withIt }, { caption: withIt }, footer)).toBe('Людина зі штучними органами');
    const overflow = withFooter('The whole long text.', footer);
    expect(
      threadsTextFromTelegram({ richDoc: null, caption: withFooter('The whole…', footer) }, { caption: '', overflowMessage: overflow }, footer),
    ).toBe('The whole…\n\nThe whole long text.');
  });

  it('is left out of a post written in the editor', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Webb finds water' }] }] } as RichDocument;
    expect(threadsTextFromTelegram({ richDoc: doc, caption: null }, { caption: '' }, footer)).toBe('Webb finds water');
  });

  it('is left out of a post published with no review', () => {
    expect(autoPublishedThreadsContent({ id: '1', media: [] }, withIt, footer).text).toBe('Людина зі штучними органами');
  });

  it('leaves a caption that does not end with it as it is', () => {
    expect(threadsTextFromTelegram({ richDoc: null, caption: 'No footer here' }, { caption: '' }, footer)).toBe('No footer here');
  });
});
