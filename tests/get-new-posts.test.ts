import { describe, expect, it, vi } from 'vitest';
import { XClient } from '@/lib/x/client';
import { compareSnowflake, getNewPosts, X_MAX_PAGES } from '@/lib/x/get-new-posts';
import { createTestLogger } from './helpers';

function xResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeClient(payload: unknown) {
  const fetchImpl = vi.fn(async () => xResponse(payload)) as unknown as typeof fetch;
  const client = new XClient({
    bearerToken: 'test',
    baseUrl: 'https://api.x.example',
    fetchImpl,
    attempts: 1,
  });
  return { client, fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn> };
}

const photoMedia = {
  media_key: '3_1',
  type: 'photo',
  url: 'https://pbs.twimg.com/media/3_1.jpg',
  width: 1200,
  height: 800,
};

const baseOptions = {
  userId: '123',
  fallbackUsername: 'testaccount',
  fetchLimit: 20,
  includeReplies: false,
  includeReposts: false,
  includeQuotes: true,
  includeTextOnly: false,
  logger: createTestLogger(),
};

describe('getNewPosts filtering', () => {
  it('keeps media posts and drops text-only posts', async () => {
    const { client } = makeClient({
      data: [
        { id: '3', text: 'with photo', attachments: { media_keys: ['3_1'] } },
        { id: '2', text: 'text only' },
      ],
      includes: { media: [photoMedia] },
      meta: { newest_id: '3', oldest_id: '2', result_count: 2 },
    });

    const result = await getNewPosts(client, baseOptions);

    expect(result.posts.map((p) => p.id)).toEqual(['3']);
    expect(result.checked).toBe(2);
    expect(result.skipped).toContainEqual({ id: '2', reason: 'no media' });
  });

  it('keeps text-only posts for a source that mirrors them', async () => {
    const { client } = makeClient({
      data: [
        { id: '3', text: 'with photo', attachments: { media_keys: ['3_1'] } },
        { id: '2', text: 'text only' },
      ],
      includes: { media: [photoMedia] },
      meta: { newest_id: '3', oldest_id: '2', result_count: 2 },
    });

    const result = await getNewPosts(client, { ...baseOptions, includeTextOnly: true });

    expect(result.posts.map((p) => p.id)).toEqual(['2', '3']);
    expect(result.posts[0]!.media).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  /**
   * Text-only means the author attached nothing. A post whose video exists but
   * cannot be sent would otherwise go out stripped of the video it is about.
   */
  it('never turns a post with unusable media into a text post', async () => {
    const { client } = makeClient({
      data: [{ id: '4', text: 'watch this', attachments: { media_keys: ['7_1'] } }],
      includes: {
        media: [{ media_key: '7_1', type: 'video', variants: [{ content_type: 'application/x-mpegURL', url: 'https://v/x.m3u8' }] }],
      },
    });

    const result = await getNewPosts(client, { ...baseOptions, includeTextOnly: true });

    expect(result.posts).toHaveLength(0);
    expect(result.skipped[0]?.reason).toMatch(/^no usable media/);
  });

  it('skips a post with neither media nor text even when text-only posts are on', async () => {
    const { client } = makeClient({
      data: [
        {
          id: '6',
          text: 'https://t.co/pic',
          entities: { urls: [{ start: 0, end: 16, url: 'https://t.co/pic', display_url: 'pic.x.com/pic' }] },
        },
      ],
    });

    const result = await getNewPosts(client, { ...baseOptions, includeTextOnly: true });

    expect(result.posts).toHaveLength(0);
    expect(result.skipped[0]).toEqual({ id: '6', reason: 'no media and no text' });
  });

  it('drops reposts by default', async () => {
    const { client } = makeClient({
      data: [
        {
          id: '5',
          text: 'RT something',
          attachments: { media_keys: ['3_1'] },
          referenced_tweets: [{ type: 'retweeted', id: '1' }],
        },
      ],
      includes: { media: [photoMedia] },
    });

    const result = await getNewPosts(client, baseOptions);
    expect(result.posts).toHaveLength(0);
    expect(result.skipped[0]).toEqual({ id: '5', reason: 'repost' });
  });

  it('drops replies by default', async () => {
    const { client } = makeClient({
      data: [
        {
          id: '5',
          text: 'a reply',
          attachments: { media_keys: ['3_1'] },
          referenced_tweets: [{ type: 'replied_to', id: '1' }],
        },
      ],
      includes: { media: [photoMedia] },
    });

    const result = await getNewPosts(client, baseOptions);
    expect(result.posts).toHaveLength(0);
    expect(result.skipped[0]).toEqual({ id: '5', reason: 'reply' });
  });

  it('keeps replies when INCLUDE_REPLIES is enabled', async () => {
    const { client } = makeClient({
      data: [
        {
          id: '5',
          text: 'a reply',
          attachments: { media_keys: ['3_1'] },
          referenced_tweets: [{ type: 'replied_to', id: '1' }],
        },
      ],
      includes: { media: [photoMedia] },
    });

    const result = await getNewPosts(client, { ...baseOptions, includeReplies: true });
    expect(result.posts.map((p) => p.id)).toEqual(['5']);
  });

  it('keeps reposts when INCLUDE_REPOSTS is enabled', async () => {
    const { client } = makeClient({
      data: [
        {
          id: '5',
          text: 'RT',
          attachments: { media_keys: ['3_1'] },
          referenced_tweets: [{ type: 'retweeted', id: '1' }],
        },
      ],
      includes: { media: [photoMedia] },
    });

    const result = await getNewPosts(client, { ...baseOptions, includeReposts: true });
    expect(result.posts.map((p) => p.id)).toEqual(['5']);
  });

  it('publishes the original but not the account\'s own follow-up reply', async () => {
    // Real pattern: an account posts media, then replies to itself with a
    // photo-credit line. The credit reply must not become its own Telegram post.
    const { client } = makeClient({
      data: [
        {
          id: '1750000000000000002',
          text: '© Jonathan Harris, rpennesi, Gail Smith/Browning Trail Cameras',
          author_id: '999',
          in_reply_to_user_id: '999',
          referenced_tweets: [{ type: 'replied_to', id: '1750000000000000001' }],
        },
        {
          id: '1750000000000000001',
          text: '',
          author_id: '999',
          attachments: { media_keys: ['7_1'] },
        },
      ],
      includes: {
        users: [{ id: '999', username: 'Trail_Cams' }],
        media: [
          {
            media_key: '7_1',
            type: 'video',
            duration_ms: 46000,
            variants: [{ bit_rate: 2176000, content_type: 'video/mp4', url: 'https://v/x.mp4' }],
          },
        ],
      },
      meta: { result_count: 2, newest_id: '1750000000000000002' },
    });

    const result = await getNewPosts(client, baseOptions);

    expect(result.posts.map((p) => p.id)).toEqual(['1750000000000000001']);
    expect(result.skipped).toContainEqual({ id: '1750000000000000002', reason: 'reply' });
  });

  it('can exclude quote posts', async () => {
    const { client } = makeClient({
      data: [
        {
          id: '5',
          text: 'quoting',
          attachments: { media_keys: ['3_1'] },
          referenced_tweets: [{ type: 'quoted', id: '1' }],
        },
      ],
      includes: { media: [photoMedia] },
    });

    const result = await getNewPosts(client, { ...baseOptions, includeQuotes: false });
    expect(result.posts).toHaveLength(0);
    expect(result.skipped[0]).toEqual({ id: '5', reason: 'quote' });
  });
});

describe('getNewPosts ordering and cursor', () => {
  it('returns posts oldest first even though X returns newest first', async () => {
    const { client } = makeClient({
      data: [
        { id: '300', text: 'c', attachments: { media_keys: ['3_1'] } },
        { id: '200', text: 'b', attachments: { media_keys: ['3_1'] } },
        { id: '100', text: 'a', attachments: { media_keys: ['3_1'] } },
      ],
      includes: { media: [photoMedia] },
      meta: { newest_id: '300' },
    });

    const result = await getNewPosts(client, baseOptions);
    expect(result.posts.map((p) => p.id)).toEqual(['100', '200', '300']);
  });

  it('derives newestId when meta omits it', async () => {
    const { client } = makeClient({
      data: [
        { id: '100', text: 'a', attachments: { media_keys: ['3_1'] } },
        { id: '300', text: 'c', attachments: { media_keys: ['3_1'] } },
      ],
      includes: { media: [photoMedia] },
    });

    const result = await getNewPosts(client, baseOptions);
    expect(result.newestId).toBe('300');
  });

  it('handles an empty timeline', async () => {
    const { client } = makeClient({ meta: { result_count: 0 } });

    const result = await getNewPosts(client, baseOptions);
    expect(result.posts).toHaveLength(0);
    expect(result.checked).toBe(0);
    expect(result.newestId).toBeNull();
  });
});

describe('request construction', () => {
  it('sends since_id and the exclude filters', async () => {
    const { client, fetchImpl } = makeClient({ data: [] });

    await getNewPosts(client, { ...baseOptions, sinceId: '999' });

    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.pathname).toBe('/2/users/123/tweets');
    expect(url.searchParams.get('since_id')).toBe('999');
    expect(url.searchParams.get('exclude')).toBe('replies,retweets');
    expect(url.searchParams.get('max_results')).toBe('20');
    expect(url.searchParams.get('media.fields')).toContain('variants');
    expect(url.searchParams.get('expansions')).toContain('attachments.media_keys');
  });

  it('omits exclude entirely when both filters are disabled', async () => {
    const { client, fetchImpl } = makeClient({ data: [] });

    await getNewPosts(client, { ...baseOptions, includeReplies: true, includeReposts: true });

    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.searchParams.has('exclude')).toBe(false);
  });
});

describe('compareSnowflake', () => {
  it('orders ids beyond Number.MAX_SAFE_INTEGER correctly', () => {
    // Both exceed 2^53; a naive Number() comparison would call these equal.
    const a = '1750000000000000001';
    const b = '1750000000000000002';
    expect(compareSnowflake(a, b)).toBeLessThan(0);
    expect(compareSnowflake(b, a)).toBeGreaterThan(0);
    expect(compareSnowflake(a, a)).toBe(0);
  });

  it('orders by length when ids differ in magnitude', () => {
    expect(compareSnowflake('999', '1000')).toBeLessThan(0);
  });
});

describe('reading back to the cursor', () => {
  /** A timeline of posts with ids `from`..`to`, newest first, `pageSize` at a time. */
  function pagedTimeline(ids: number[], pageSize: number) {
    const requests: URL[] = [];
    const fetchImpl = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      requests.push(url);
      const sinceId = Number(url.searchParams.get('since_id') ?? 0);
      const untilId = Number(url.searchParams.get('until_id') ?? Number.MAX_SAFE_INTEGER);
      const available = ids.filter((id) => id > sinceId && id < untilId).sort((a, b) => b - a);
      const page = available.slice(0, pageSize);
      return xResponse({
        data: page.map((id) => ({ id: String(id), text: `post ${id}`, attachments: { media_keys: [`k${id}`] } })),
        includes: {
          media: page.map((id) => ({ ...photoMedia, media_key: `k${id}`, url: `https://pbs.twimg.com/media/${id}.jpg` })),
        },
        meta: {
          result_count: page.length,
          ...(page.length > 0 ? { newest_id: String(page[0]), oldest_id: String(page[page.length - 1]) } : {}),
          ...(available.length > page.length ? { next_token: 'more' } : {}),
        },
      });
    });
    const client = new XClient({
      bearerToken: 'test',
      baseUrl: 'https://api.x.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      attempts: 1,
    });
    return { client, requests };
  }

  it('reads older pages down to the cursor, so the oldest new posts are not skipped', async () => {
    // Cursor at 100; posts 101..112 arrived since; X pages 5 at a time.
    const ids = Array.from({ length: 12 }, (_, index) => 101 + index);
    const { client, requests } = pagedTimeline(ids, 5);

    const result = await getNewPosts(client, { ...baseOptions, fetchLimit: 5, sinceId: '100' });

    expect(result.posts.map((post) => post.id)).toEqual(ids.map(String));
    expect(result).toMatchObject({ pages: 3, overflow: false, checked: 12, newestId: '112' });
    expect(requests.map((url) => [url.searchParams.get('since_id'), url.searchParams.get('until_id')])).toEqual([
      ['100', null],
      ['100', '108'],
      ['100', '103'],
    ]);
    // Media from every page is matched to its post.
    expect(result.posts[0]!.media[0]!.url).toContain('101');
  });

  it('reads one page only on a source\'s first run, with no cursor', async () => {
    const { client, requests } = pagedTimeline(Array.from({ length: 12 }, (_, index) => 101 + index), 5);

    const result = await getNewPosts(client, { ...baseOptions, fetchLimit: 5 });

    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ pages: 1, overflow: false });
    expect(result.posts.map((post) => post.id)).toEqual(['108', '109', '110', '111', '112']);
  });

  it('stops after the page limit and says the oldest were not read', async () => {
    const logger = createTestLogger();
    const ids = Array.from({ length: 40 }, (_, index) => 101 + index);
    const { client, requests } = pagedTimeline(ids, 5);

    const result = await getNewPosts(client, { ...baseOptions, fetchLimit: 5, sinceId: '100', logger });

    expect(requests).toHaveLength(X_MAX_PAGES);
    expect(result).toMatchObject({ pages: X_MAX_PAGES, overflow: true, checked: 25 });
    expect(logger.entries.map((entry) => entry.event)).toContain('sync.window_overflow');
  });
});
