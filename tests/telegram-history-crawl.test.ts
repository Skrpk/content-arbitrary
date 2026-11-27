import { describe, expect, it, vi } from 'vitest';
import { ChannelPageError } from '@/lib/errors';
import { crawlChannelHistory } from '@/lib/onboarding/telegram-history';
import { parseChannelPage } from '@/lib/telegram-channel/parser';
import { CDN, channelPage, type FakeMessage } from './channel-page-fakes';

/**
 * What onboarding reads of a channel: the links and forwards in its posts,
 * and its latest posts, page by page, as canonical history.
 */

describe('links and forwards in a post', () => {
  const page = parseChannelPage(
    channelPage([
      {
        id: 10,
        text:
          'Read <a href="https://blog.playstation.com/2026/11/27/news/#top" target="_blank">the announcement</a>, ' +
          '<a href="?q=%23PS5">#PS5</a>, <a href="https://t.me/gamingnews_ua">@gamingnews_ua</a>, ' +
          '<a href="https://t.me/spacenews/9">our earlier post</a>, <a href="https://t.me/spacenews">us</a>, ' +
          '<a href="tg://resolve?domain=x">app</a>, <a href="mailto:hi@example.org">mail</a>, ' +
          '<a href="https://t.me/+AbCdEf123">invite</a>, <a href="https://t.me/s/other">web view</a>, ' +
          '<a href="https://l.facebook.com/l.php?u=https%3A%2F%2Feurogamer.net%2Fstory&h=x">fb</a>, ' +
          '<a href="https://blog.playstation.com/2026/11/27/news/">again</a>',
        linkPreview: true,
        previewHref: 'https://www.youtube.com/watch?v=abc123',
      },
      { id: 11, text: 'Shared', forwarded: true, forwardedFromHref: 'https://t.me/PlayStationUA/4521' },
      { id: 12, text: 'Shared from a channel', forwarded: true, forwardedFromHref: 'https://t.me/vgc_news' },
      { id: 13, text: 'Shared from someone hidden', forwarded: true, forwardedFromHref: null },
      { id: 14, text: 'A reply, quoting a post with a link', replyTo: 10 },
    ]),
  );
  const post = (id: number) => page.posts.find((candidate) => candidate.messageId === id)!;

  it('keeps the post’s own outbound links and its card’s, once each, unwrapping only a redirect that names its target', () => {
    expect(post(10).outboundLinks).toEqual([
      { url: 'https://blog.playstation.com/2026/11/27/news/', label: 'the announcement' },
      { url: 'https://t.me/gamingnews_ua', label: '@gamingnews_ua' },
      { url: 'https://eurogamer.net/story', label: 'fb' },
      { url: 'https://www.youtube.com/watch?v=abc123', label: 'A linked story' },
    ]);
  });

  it('names the public channel a forward came from, and nothing for a hidden one', () => {
    expect(post(11).forwardedFrom).toEqual({ username: 'PlayStationUA', messageId: 4521 });
    expect(post(12).forwardedFrom).toEqual({ username: 'vgc_news' });
    expect(post(13).forwarded).toBe(true);
    expect(post(13).forwardedFrom).toBeUndefined();
    expect(post(14).outboundLinks).toBeUndefined();
    expect(post(14).forwardedFrom).toBeUndefined();
  });
});

/** A channel of `count` posts, ids 1..count, served 20 to a page as t.me does. */
function fakeChannel(count: number, options: { post?: (id: number) => Partial<FakeMessage>; rateLimitFirst?: number } = {}) {
  const requested: string[] = [];
  let limited = 0;
  const fetchImpl = vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    requested.push(url.search);
    if (options.rateLimitFirst && limited < 1) {
      limited += 1;
      return new Response('', { status: 429, headers: { 'retry-after': String(options.rateLimitFirst) } });
    }
    const before = Number(url.searchParams.get('before') ?? count + 1);
    const ids = Array.from({ length: count }, (_, index) => index + 1).filter((id) => id < before).slice(-20);
    const messages = ids.map((id) => ({
      id,
      text: `Post ${id}`,
      date: new Date(Date.UTC(2026, 10, 1) + id * 3_600_000).toISOString(),
      ...options.post?.(id),
    }));
    return new Response(channelPage(messages, 'PlayStation UA', 'spacenews'), { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requested };
}

describe('reading a channel’s latest posts', () => {
  const sleep = vi.fn(async () => {});

  it('pages back until it has the latest 100 usable posts, newest first, keyed like an export', async () => {
    const channel = fakeChannel(500);
    const crawl = await crawlChannelHistory('spacenews', { publicationKey: '-1001234567890', fetchImpl: channel.fetchImpl, sleep });

    expect(channel.requested).toEqual(['', '?before=481', '?before=461', '?before=441', '?before=421']);
    expect(crawl).toMatchObject({ title: 'PlayStation UA', inspected: 100, usable: 100, exhausted: false });
    const { parsed } = crawl;
    expect(parsed).toMatchObject({ platform: 'telegram', publicationKey: '-1001234567890', publicationName: 'PlayStation UA' });
    expect(parsed.items.map((item) => item.externalId).slice(0, 2)).toEqual(['500', '499']);
    expect(parsed.items.at(-1)!.externalId).toBe('401');
    expect(parsed.items[0]).toMatchObject({
      contentType: 'post',
      text: 'Post 500',
      canonicalUrl: 'https://t.me/spacenews/500',
      media: [],
      metrics: { views: 1200 },
    });
    expect(crawl.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('looks at no more than 200 messages, however few of them are usable', async () => {
    const channel = fakeChannel(500, { post: (id) => (id % 4 === 0 ? {} : { text: '', poll: false }) });
    const crawl = await crawlChannelHistory('spacenews', { publicationKey: 'k', fetchImpl: channel.fetchImpl, sleep });
    expect(crawl.inspected).toBe(200);
    expect(crawl.usable).toBe(50);
    expect(crawl.parsed.skipped.filter((issue) => issue.reason === 'no_text_or_media')).toHaveLength(150);
  });

  it('stops when the channel runs out, and keeps a picture or an unplayable video as something it published', async () => {
    const channel = fakeChannel(30, {
      post: (id) => (id === 1 ? { text: undefined, photos: [`${CDN}/a.jpg`] } : id === 2 ? { text: undefined, video: { src: null } } : {}),
    });
    const crawl = await crawlChannelHistory('spacenews', { publicationKey: 'k', fetchImpl: channel.fetchImpl, sleep });
    expect(crawl).toMatchObject({ inspected: 30, usable: 30, exhausted: true });
    const byId = (id: string) => crawl.parsed.items.find((item) => item.externalId === id)!;
    expect(byId('1')).toMatchObject({ text: null, media: [{ type: 'photo', relativePath: null, available: false }] });
    expect(byId('2').media).toEqual([{ type: 'video', relativePath: null, available: false }]);
  });

  it('keeps where a post was forwarded from and what it links to', async () => {
    const channel = fakeChannel(3, {
      post: (id) =>
        id === 3
          ? { forwarded: true, forwardedFromHref: 'https://t.me/vgc_news/77', text: '<a href="https://vgc.com/a">story</a>' }
          : {},
    });
    const crawl = await crawlChannelHistory('spacenews', { publicationKey: 'k', fetchImpl: channel.fetchImpl, sleep });
    expect(crawl.parsed.items[0]!.metadata).toEqual({
      forwarded: true,
      forwardedFrom: 'vgc_news',
      forwardedFromMessageId: 77,
      outboundLinks: [{ url: 'https://vgc.com/a', label: 'story' }],
    });
  });

  it('waits out a short rate limit, and gives up on a long one as transient', async () => {
    const short = fakeChannel(10, { rateLimitFirst: 2 });
    const waited: number[] = [];
    const crawl = await crawlChannelHistory('spacenews', {
      publicationKey: 'k',
      fetchImpl: short.fetchImpl,
      sleep: async (ms) => {
        waited.push(ms);
      },
    });
    expect(waited).toContain(2000);
    expect(crawl.usable).toBe(10);

    const long = fakeChannel(10, { rateLimitFirst: 120 });
    const failure = await crawlChannelHistory('spacenews', { publicationKey: 'k', fetchImpl: long.fetchImpl, sleep }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChannelPageError);
    expect(failure).toMatchObject({ transient: true, code: 'channel_rate_limited', retryAfterMs: 120_000 });
  });
});
