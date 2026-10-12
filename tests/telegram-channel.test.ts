import { describe, expect, it, vi } from 'vitest';
import { ChannelPageError } from '@/lib/errors';
import { fetchChannelPage } from '@/lib/telegram-channel/client';
import { channelPostToPost, parseChannelPostId } from '@/lib/telegram-channel/normalize';
import { parseChannelPage, parseCount, parseDuration } from '@/lib/telegram-channel/parser';
import { looksLikeTelegramChannel, normalizeChannelUsername } from '@/lib/telegram-channel/username';
import { platformOfPostId, sourceLabelOfPost } from '@/lib/sources/display';
import { CDN, channelPage } from './channel-page-fakes';

describe('a channel named however it was pasted', () => {
  it('comes down to its username, lower-cased', () => {
    for (const input of ['SpaceNews', '@spacenews', 't.me/spacenews', 'https://t.me/s/SpaceNews', 'https://t.me/spacenews/123', 'telegram.me/spacenews?x=1']) {
      expect(normalizeChannelUsername(input)).toEqual({ ok: true, username: 'spacenews' });
    }
  });

  it('turns away invite links, other sites and what cannot be a username', () => {
    expect(normalizeChannelUsername('https://t.me/+AbCdEf123')).toEqual({ ok: false, reason: 'private' });
    expect(normalizeChannelUsername('t.me/joinchat/AbCdEf')).toEqual({ ok: false, reason: 'private' });
    expect(normalizeChannelUsername('https://example.com/spacenews')).toEqual({ ok: false, reason: 'invalid' });
    expect(normalizeChannelUsername('1spacenews')).toEqual({ ok: false, reason: 'invalid' });
    expect(normalizeChannelUsername('space news')).toEqual({ ok: false, reason: 'invalid' });
    expect(normalizeChannelUsername('t.me/s/')).toEqual({ ok: false, reason: 'empty' });
  });

  it('is told apart from a feed URL in the one "add a source" field', () => {
    expect(looksLikeTelegramChannel('@spacenews')).toBe(true);
    expect(looksLikeTelegramChannel('https://t.me/spacenews')).toBe(true);
    expect(looksLikeTelegramChannel('https://example.com/feed.xml')).toBe(false);
  });
});

describe("a channel's page", () => {
  const html = channelPage([
    { id: 10, text: 'Plain words with <b>bold</b>,<br/>a <a href="https://esa.int">link</a> &amp; an <i class="emoji"><b>🚀</b></i>', views: '77.5K', date: '2099-01-15T10:00:00+00:00' },
    { id: 11, text: 'One photo', photos: [`${CDN}/one.jpg`] },
    { id: 12, text: 'An album', photos: [`${CDN}/a.jpg`, `${CDN}/b.jpg`, `${CDN}/c.jpg`] },
    { id: 15, text: 'A clip', video: { src: `${CDN}/clip.mp4?token=abc`, duration: '1:15' } },
    { id: 16, text: 'Too big', video: { src: null } },
    { id: 17, text: 'Shared', forwarded: true, photos: [`${CDN}/fwd.jpg`] },
    { id: 18, text: 'Vote', poll: true },
    { id: 19, text: 'A reply, with a link card', replyTo: 11, linkPreview: true },
  ]);
  const page = parseChannelPage(html);
  const post = (id: number) => page.posts.find((entry) => entry.messageId === id)!;

  it('names the channel and lists every post', () => {
    expect(page.title).toBe('Space News');
    expect(page.posts.map((entry) => entry.messageId)).toEqual([10, 11, 12, 15, 16, 17, 18, 19]);
  });

  it('reads the text as plain text, line breaks and emoji kept', () => {
    expect(post(10)).toMatchObject({
      text: 'Plain words with bold,\na link & an 🚀',
      views: 77500,
      url: 'https://t.me/spacenews/10',
      media: [],
      unsupported: [],
    });
    expect(post(10).publishedAt?.toISOString()).toBe('2099-01-15T10:00:00.000Z');
  });

  it("takes an album's items in order, each as the message it is", () => {
    expect(post(12).media).toEqual([
      { key: 'spacenews/12', kind: 'photo', url: `${CDN}/a.jpg` },
      { key: 'spacenews/13', kind: 'photo', url: `${CDN}/b.jpg` },
      { key: 'spacenews/14', kind: 'photo', url: `${CDN}/c.jpg` },
    ]);
  });

  it('takes a video with its still and length, and says when the page cannot play one', () => {
    expect(post(15).media).toEqual([
      { key: 'spacenews/15', kind: 'video', url: `${CDN}/clip.mp4?token=abc`, previewUrl: `${CDN}/thumb.jpg`, durationSeconds: 75 },
    ]);
    expect(post(16)).toMatchObject({ media: [], unsupported: ['a video too large for the web page'] });
    expect(post(18).unsupported).toEqual(['a poll']);
  });

  it('marks a forward, and leaves out what a reply quotes and what a link card shows', () => {
    expect(post(17).forwarded).toBe(true);
    expect(post(19)).toMatchObject({ text: 'A reply, with a link card', media: [], forwarded: false });
  });

  it('becomes a candidate post under its own id', () => {
    const candidate = channelPostToPost(post(12));
    expect(candidate).toMatchObject({
      platform: 'telegram',
      id: 'tg:spacenews/12',
      url: 'https://t.me/spacenews/12',
      authorUsername: 'spacenews',
      isRepost: false,
    });
    expect(candidate.media.map((media) => media.mediaKey)).toEqual(['tg:spacenews/12', 'tg:spacenews/13', 'tg:spacenews/14']);
    expect(parseChannelPostId(candidate.id)).toEqual({ channel: 'spacenews', messageId: 12 });
    expect(platformOfPostId(candidate.id)).toBe('telegram');
    expect(sourceLabelOfPost(candidate.id, 'spacenews')).toBe('@spacenews');
  });

  it('never takes media from anywhere but Telegram', () => {
    const hostile = parseChannelPage(channelPage([{ id: 30, text: 'x', photos: ['http://169.254.169.254/latest'] }]));
    expect(hostile.posts).toEqual([]);
  });

  it('reads the counts and lengths the page rounds', () => {
    expect(parseCount('653')).toBe(653);
    expect(parseCount('1.83M')).toBe(1_830_000);
    expect(parseCount('')).toBeNull();
    expect(parseDuration('1:02:03')).toBe(3723);
    expect(parseDuration('soon')).toBeNull();
  });
});

describe('fetching a channel page', () => {
  it('reads t.me/s/<channel>, and the page before a message when asked', async () => {
    const fetchImpl = vi.fn(async () => new Response(channelPage([{ id: 1, text: 'hi' }]), { status: 200 }));
    await fetchChannelPage('spacenews', { fetchImpl: fetchImpl as unknown as typeof fetch, before: 40 });
    expect(fetchImpl).toHaveBeenCalledWith('https://t.me/s/spacenews?before=40', expect.objectContaining({ redirect: 'manual' }));
  });

  it('reports a name with no public page — t.me redirects it — as permanent', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://t.me/nope' } }));
    const error = await fetchChannelPage('nope_channel', { fetchImpl: fetchImpl as unknown as typeof fetch }).catch((caught) => caught);
    expect(error).toBeInstanceOf(ChannelPageError);
    expect(error).toMatchObject({ code: 'channel_no_preview', transient: false });
  });

  it('treats rate limiting and server errors as worth another try', async () => {
    const fetchImpl = vi.fn(async () => new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }));
    const error = await fetchChannelPage('spacenews', { fetchImpl: fetchImpl as unknown as typeof fetch }).catch((caught) => caught);
    expect(error).toMatchObject({ code: 'channel_rate_limited', transient: true, retryAfterMs: 30_000 });
  });
});
