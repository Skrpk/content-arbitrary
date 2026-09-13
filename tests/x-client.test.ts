import { describe, expect, it, vi } from 'vitest';
import { XClient } from '@/lib/x/client';
import { XApiError } from '@/lib/errors';
import { xTimelineResponseSchema } from '@/lib/x/schemas';

function json(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function makeClient(fetchImpl: typeof fetch, attempts = 3) {
  return new XClient({
    bearerToken: 'secret-token',
    baseUrl: 'https://api.x.example',
    fetchImpl,
    attempts,
  });
}

describe('response parsing', () => {
  it('parses a realistic timeline payload', () => {
    const payload = {
      data: [
        {
          id: '1750000000000000001',
          text: 'Four photos https://t.co/abc',
          created_at: '2026-01-15T10:30:00.000Z',
          author_id: '999',
          attachments: { media_keys: ['3_1', '3_2'] },
          entities: {
            urls: [
              {
                start: 12,
                end: 35,
                url: 'https://t.co/abc',
                expanded_url: 'https://x.com/user/status/1/photo/1',
                display_url: 'pic.x.com/abc',
              },
            ],
          },
        },
      ],
      includes: {
        media: [
          { media_key: '3_1', type: 'photo', url: 'https://pbs.twimg.com/media/1.jpg', width: 1, height: 1 },
          {
            media_key: '3_2',
            type: 'video',
            duration_ms: 1000,
            variants: [{ bit_rate: 100, content_type: 'video/mp4', url: 'https://v/1.mp4' }],
          },
        ],
        users: [{ id: '999', username: 'someuser', name: 'Some User' }],
      },
      meta: { result_count: 1, newest_id: '1750000000000000001', oldest_id: '1750000000000000001' },
    };

    const parsed = xTimelineResponseSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.data![0]!.id).toBe('1750000000000000001');
    expect(parsed.data!.includes!.media![1]!.variants![0]!.bit_rate).toBe(100);
  });

  it('accepts unknown extra fields the API may add later', () => {
    const parsed = xTimelineResponseSchema.safeParse({
      data: [{ id: '1', text: 'x', some_new_field: true }],
      brand_new_top_level: 42,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a payload where a post id is not a string', () => {
    const parsed = xTimelineResponseSchema.safeParse({ data: [{ id: 123, text: 'x' }] });
    expect(parsed.success).toBe(false);
  });

  it('surfaces a schema mismatch as a non-retryable error', async () => {
    const fetchImpl = vi.fn(async () => json({ data: [{ id: 5, text: 'bad' }] })) as unknown as typeof fetch;

    await expect(
      makeClient(fetchImpl).getUserTimeline({
        userId: '1',
        maxResults: 10,
        excludeReplies: true,
        excludeReposts: true,
      }),
    ).rejects.toThrow(/Unexpected X timeline response/);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('authentication and errors', () => {
  it('sends the bearer token in the Authorization header', async () => {
    const fetchImpl = vi.fn(async () => json({ data: [] })) as unknown as typeof fetch;

    await makeClient(fetchImpl).getUserTimeline({
      userId: '1',
      maxResults: 10,
      excludeReplies: true,
      excludeReposts: true,
    });

    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret-token');
  });

  it('does not retry a 401', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('unauthorized', { status: 401 }),
    ) as unknown as typeof fetch;

    await expect(
      makeClient(fetchImpl).getUserTimeline({
        userId: '1',
        maxResults: 10,
        excludeReplies: true,
        excludeReposts: true,
      }),
    ).rejects.toBeInstanceOf(XApiError);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a 503 and then succeeds', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1 ? new Response('down', { status: 503 }) : json({ data: [] });
    }) as unknown as typeof fetch;

    const client = new XClient({
      bearerToken: 'secret-token',
      baseUrl: 'https://api.x.example',
      fetchImpl,
      attempts: 3,
    });

    // Real backoff would sleep; the first delay is short enough for a test.
    await expect(
      client.getUserTimeline({ userId: '1', maxResults: 10, excludeReplies: true, excludeReposts: true }),
    ).resolves.toBeDefined();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('reads the rate-limit reset header on a 429', async () => {
    const resetAt = Math.floor((Date.now() + 5000) / 1000);
    const fetchImpl = vi.fn(
      async () =>
        new Response('rate limited', {
          status: 429,
          headers: { 'x-rate-limit-reset': String(resetAt) },
        }),
    ) as unknown as typeof fetch;

    const client = new XClient({
      bearerToken: 't',
      baseUrl: 'https://api.x.example',
      fetchImpl,
      attempts: 1,
    });

    await expect(
      client.getUserTimeline({ userId: '1', maxResults: 10, excludeReplies: true, excludeReposts: true }),
    ).rejects.toMatchObject({ code: 'x_rate_limited', transient: true });
  });
});

describe('getUserByUsername', () => {
  it('resolves a handle to a numeric id', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ data: { id: '1234567890', username: 'someuser', name: 'Some User' } }),
    ) as unknown as typeof fetch;

    const user = await makeClient(fetchImpl).getUserByUsername('@someuser');
    expect(user.id).toBe('1234567890');

    const url = new URL(String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]));
    expect(url.pathname).toBe('/2/users/by/username/someuser');
  });

  it('reports a clear error when the account does not exist', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ errors: [{ title: 'Not Found Error', detail: 'Could not find user' }] }),
    ) as unknown as typeof fetch;

    await expect(makeClient(fetchImpl).getUserByUsername('ghost')).rejects.toThrow(
      /Could not resolve @ghost/,
    );
  });
});
