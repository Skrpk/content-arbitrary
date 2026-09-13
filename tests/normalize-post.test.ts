import { describe, expect, it } from 'vitest';
import {
  cleanPostText,
  extractMedia,
  isSelfMediaUrlEntity,
  normalizePost,
  selectBestVideoVariant,
} from '@/lib/x/normalize-post';
import type { XMedia, XPost } from '@/lib/x/schemas';

describe('isSelfMediaUrlEntity', () => {
  it('detects the pic.x.com link X appends for attached media', () => {
    expect(
      isSelfMediaUrlEntity({
        start: 10,
        end: 33,
        url: 'https://t.co/abc123',
        expanded_url: 'https://x.com/user/status/123/photo/1',
        display_url: 'pic.x.com/abc123',
      }),
    ).toBe(true);
  });

  it('detects the legacy pic.twitter.com form', () => {
    expect(
      isSelfMediaUrlEntity({
        start: 0,
        end: 1,
        url: 'https://t.co/xyz',
        display_url: 'pic.twitter.com/xyz',
      }),
    ).toBe(true);
  });

  it('detects a video permalink', () => {
    expect(
      isSelfMediaUrlEntity({
        start: 0,
        end: 1,
        url: 'https://t.co/vid',
        expanded_url: 'https://twitter.com/user/status/999/video/1',
      }),
    ).toBe(true);
  });

  it('detects an entity carrying a media_key', () => {
    expect(
      isSelfMediaUrlEntity({ start: 0, end: 1, url: 'https://t.co/m', media_key: '3_123' }),
    ).toBe(true);
  });

  it('does not flag a genuine link the author wrote', () => {
    expect(
      isSelfMediaUrlEntity({
        start: 0,
        end: 1,
        url: 'https://t.co/real',
        expanded_url: 'https://example.com/article',
        display_url: 'example.com/article',
      }),
    ).toBe(false);
  });

  it('does not flag a link to another X post', () => {
    expect(
      isSelfMediaUrlEntity({
        start: 0,
        end: 1,
        url: 'https://t.co/quote',
        expanded_url: 'https://x.com/someone/status/555',
        display_url: 'x.com/someone/statu…',
      }),
    ).toBe(false);
  });
});

describe('cleanPostText', () => {
  it('removes the trailing media t.co link entirely', () => {
    const text = 'Look at this https://t.co/media1';
    const result = cleanPostText(text, [
      {
        start: 13,
        end: 36,
        url: 'https://t.co/media1',
        expanded_url: 'https://x.com/user/status/123/photo/1',
        display_url: 'pic.x.com/media1',
      },
    ]);

    expect(result).toBe('Look at this');
    expect(result).not.toContain('t.co');
  });

  it('expands a real t.co link to the URL the author actually shared', () => {
    const result = cleanPostText('Read more: https://t.co/short', [
      {
        start: 11,
        end: 30,
        url: 'https://t.co/short',
        expanded_url: 'https://example.com/full-article',
        display_url: 'example.com/full-article',
      },
    ]);

    expect(result).toBe('Read more: https://example.com/full-article');
  });

  it('keeps the author link while dropping the media link in the same post', () => {
    const result = cleanPostText('See https://t.co/real and https://t.co/media', [
      {
        start: 4,
        end: 22,
        url: 'https://t.co/real',
        expanded_url: 'https://example.com/x',
        display_url: 'example.com/x',
      },
      {
        start: 27,
        end: 46,
        url: 'https://t.co/media',
        expanded_url: 'https://x.com/user/status/1/photo/1',
        display_url: 'pic.x.com/media',
      },
    ]);

    expect(result).toBe('See https://example.com/x and');
  });

  it('unescapes the HTML entities X returns in post text', () => {
    expect(cleanPostText('Tom &amp; Jerry &lt;3', [])).toBe('Tom & Jerry <3');
  });

  it('preserves paragraph breaks the author wrote', () => {
    expect(cleanPostText('Line one\n\nLine two', [])).toBe('Line one\n\nLine two');
  });

  it('does not corrupt emoji when cleaning', () => {
    const text = '🎉 Party 👨‍👩‍👧‍👦 time https://t.co/media';
    const result = cleanPostText(text, [
      { start: 0, end: 1, url: 'https://t.co/media', display_url: 'pic.x.com/media' },
    ]);

    expect(result).toBe('🎉 Party 👨‍👩‍👧‍👦 time');
    expect(result).not.toContain('�');
  });

  it('handles a post with no entities at all', () => {
    expect(cleanPostText('Just text', undefined)).toBe('Just text');
  });
});

describe('selectBestVideoVariant', () => {
  const media: XMedia = {
    media_key: '7_1',
    type: 'video',
    variants: [
      { bit_rate: 256000, content_type: 'video/mp4', url: 'https://video.twimg.com/low.mp4' },
      { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/playlist.m3u8' },
      { bit_rate: 2176000, content_type: 'video/mp4', url: 'https://video.twimg.com/high.mp4' },
      { bit_rate: 832000, content_type: 'video/mp4', url: 'https://video.twimg.com/mid.mp4' },
    ],
  };

  it('picks the highest-bitrate MP4', () => {
    const result = selectBestVideoVariant(media);
    expect(result).toEqual({
      url: 'https://video.twimg.com/high.mp4',
      bitRate: 2176000,
      contentType: 'video/mp4',
    });
  });

  it('never selects an HLS playlist', () => {
    expect(selectBestVideoVariant(media)!.url).not.toContain('.m3u8');
  });

  it('returns null when only HLS is available', () => {
    expect(
      selectBestVideoVariant({
        media_key: '7_2',
        type: 'video',
        variants: [{ content_type: 'application/x-mpegURL', url: 'https://v/playlist.m3u8' }],
      }),
    ).toBeNull();
  });

  it('returns null when there are no variants', () => {
    expect(selectBestVideoVariant({ media_key: '7_3', type: 'video' })).toBeNull();
  });
});

describe('extractMedia', () => {
  const photo = (key: string): XMedia => ({
    media_key: key,
    type: 'photo',
    url: `https://pbs.twimg.com/media/${key}.jpg`,
    width: 1200,
    height: 800,
  });

  it('extracts multiple photos in the author\'s order', () => {
    const post = { id: '1', text: '', attachments: { media_keys: ['3_a', '3_b', '3_c'] } } as XPost;
    const map = new Map([photo('3_a'), photo('3_b'), photo('3_c')].map((m) => [m.media_key, m]));

    const { media } = extractMedia(post, map);
    expect(media.map((m) => m.mediaKey)).toEqual(['3_a', '3_b', '3_c']);
    expect(media.every((m) => m.kind === 'photo')).toBe(true);
  });

  it('de-duplicates a repeated media key', () => {
    const post = { id: '1', text: '', attachments: { media_keys: ['3_a', '3_a'] } } as XPost;
    const map = new Map([[photo('3_a').media_key, photo('3_a')]]);

    expect(extractMedia(post, map).media).toHaveLength(1);
  });

  it('converts video duration from milliseconds to seconds', () => {
    const post = { id: '1', text: '', attachments: { media_keys: ['7_a'] } } as XPost;
    const video: XMedia = {
      media_key: '7_a',
      type: 'video',
      duration_ms: 30_500,
      width: 1280,
      height: 720,
      variants: [{ bit_rate: 1000, content_type: 'video/mp4', url: 'https://v/x.mp4' }],
    };

    const { media } = extractMedia(post, new Map([['7_a', video]]));
    expect(media[0]).toMatchObject({ kind: 'video', durationSeconds: 31, width: 1280, height: 720 });
  });

  it('treats animated_gif as a video and flags its origin', () => {
    const post = { id: '1', text: '', attachments: { media_keys: ['16_a'] } } as XPost;
    const gif: XMedia = {
      media_key: '16_a',
      type: 'animated_gif',
      variants: [{ bit_rate: 0, content_type: 'video/mp4', url: 'https://v/g.mp4' }],
    };

    const { media } = extractMedia(post, new Map([['16_a', gif]]));
    expect(media[0]).toMatchObject({ kind: 'video', wasAnimatedGif: true });
  });

  it('handles a mixed photo + video post', () => {
    const post = { id: '1', text: '', attachments: { media_keys: ['3_a', '7_a'] } } as XPost;
    const video: XMedia = {
      media_key: '7_a',
      type: 'video',
      variants: [{ bit_rate: 1, content_type: 'video/mp4', url: 'https://v/x.mp4' }],
    };

    const { media } = extractMedia(post, new Map<string, XMedia>([['3_a', photo('3_a')], ['7_a', video]]));
    expect(media.map((m) => m.kind)).toEqual(['photo', 'video']);
  });

  it('reports a video with no MP4 as unsupported instead of throwing', () => {
    const post = { id: '1', text: '', attachments: { media_keys: ['7_a'] } } as XPost;
    const video: XMedia = {
      media_key: '7_a',
      type: 'video',
      variants: [{ content_type: 'application/x-mpegURL', url: 'https://v/p.m3u8' }],
    };

    const { media, unsupported } = extractMedia(post, new Map([['7_a', video]]));
    expect(media).toHaveLength(0);
    expect(unsupported[0]).toContain('no progressive MP4');
  });

  it('reports media missing from includes rather than crashing', () => {
    const post = { id: '1', text: '', attachments: { media_keys: ['3_missing'] } } as XPost;
    const { media, unsupported } = extractMedia(post, new Map());
    expect(media).toHaveLength(0);
    expect(unsupported[0]).toContain('not present in includes.media');
  });
});

describe('normalizePost', () => {
  it('classifies a reply', () => {
    const post = {
      id: '1',
      text: 'reply',
      referenced_tweets: [{ type: 'replied_to', id: '99' }],
    } as XPost;

    expect(normalizePost(post, new Map(), 'user').post.isReply).toBe(true);
  });

  it('classifies a repost', () => {
    const post = {
      id: '1',
      text: 'RT',
      referenced_tweets: [{ type: 'retweeted', id: '99' }],
    } as XPost;

    expect(normalizePost(post, new Map(), 'user').post.isRepost).toBe(true);
  });

  it('classifies a quote post', () => {
    const post = {
      id: '1',
      text: 'quote',
      referenced_tweets: [{ type: 'quoted', id: '99' }],
    } as XPost;

    const result = normalizePost(post, new Map(), 'user').post;
    expect(result.isQuote).toBe(true);
    expect(result.isRepost).toBe(false);
  });

  it('treats in_reply_to_user_id as a reply marker', () => {
    const post = { id: '1', text: 'x', in_reply_to_user_id: '42' } as XPost;
    expect(normalizePost(post, new Map(), 'user').post.isReply).toBe(true);
  });

  it('builds the canonical post URL', () => {
    const post = { id: '123', text: 'x' } as XPost;
    expect(normalizePost(post, new Map(), 'someuser').post.url).toBe(
      'https://x.com/someuser/status/123',
    );
  });
});
