import { describe, expect, it, vi } from 'vitest';
import { XClient } from '@/lib/x/client';
import { compareSnowflake, getNewPosts } from '@/lib/x/get-new-posts';
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
