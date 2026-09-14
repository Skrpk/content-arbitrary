import { describe, expect, it, vi } from 'vitest';
import { chooseMethod, processPost } from '@/lib/sync/process-post';
import { TelegramClient } from '@/lib/telegram/client';
import type { NormalizedMedia, NormalizedPost } from '@/types';
import { createTestLogger, instantSleep, telegramError, telegramOk, withEnv } from './helpers';

const photo = (key: string): NormalizedMedia => ({
  mediaKey: key,
  kind: 'photo',
  url: `https://pbs.twimg.com/media/${key}.jpg`,
  width: 1200,
  height: 800,
});

const video = (key: string): NormalizedMedia => ({
  mediaKey: key,
  kind: 'video',
  url: `https://video.twimg.com/${key}.mp4`,
  width: 1280,
  height: 720,
  durationSeconds: 30,
  contentType: 'video/mp4',
});

function makePost(media: NormalizedMedia[], text = 'Hello world'): NormalizedPost {
  return {
    id: '1234567890123456789',
    url: 'https://x.com/testaccount/status/1234567890123456789',
    authorUsername: 'testaccount',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    text,
    media,
    isReply: false,
    isRepost: false,
    isQuote: false,
  };
}

/** Serves media downloads and Telegram calls from one fetch mock. */
function makeFetch(options?: {
  telegram?: (method: string, call: number) => Response;
  mediaBytes?: number;
}) {
  const telegramCalls: { method: string; body: FormData | string }[] = [];
  let telegramCallCount = 0;

  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof URL ? input.toString() : input);

    if (url.includes('api.telegram.example')) {
      telegramCallCount += 1;
      const method = url.split('/').pop()!;
      telegramCalls.push({ method, body: init!.body as FormData | string });

      if (options?.telegram) return options.telegram(method, telegramCallCount);

      if (method === 'sendMediaGroup') {
        return telegramOk([
          { message_id: 100, chat: { id: -1001234567890 } },
          { message_id: 101, chat: { id: -1001234567890 } },
        ]);
      }
      return telegramOk({ message_id: 100, chat: { id: -1001234567890 } });
    }

    // Media CDN
    const size = options?.mediaBytes ?? 1024;
    return new Response(new Uint8Array(size), {
      status: 200,
      headers: {
        'content-type': url.includes('.mp4') ? 'video/mp4' : 'image/jpeg',
        'content-length': String(size),
      },
    });
  });

  return { fetchImpl: fetchImpl as unknown as typeof fetch, telegramCalls };
}

function makeClient(fetchImpl: typeof fetch) {
  return new TelegramClient({
    token: '123456:TEST',
    baseUrl: 'https://api.telegram.example',
    fetchImpl,
    attempts: 3,
    sleep: instantSleep,
  });
}

describe('chooseMethod', () => {
  it('uses sendPhoto for a single photo', () => {
    expect(chooseMethod([photo('a')])).toBe('sendPhoto');
  });

  it('uses sendVideo for a single video', () => {
    expect(chooseMethod([video('a')])).toBe('sendVideo');
  });

  it('uses sendMediaGroup for two photos', () => {
    expect(chooseMethod([photo('a'), photo('b')])).toBe('sendMediaGroup');
  });

  it('uses sendMediaGroup for four photos', () => {
    expect(chooseMethod([photo('a'), photo('b'), photo('c'), photo('d')])).toBe('sendMediaGroup');
  });

  it('uses sendMediaGroup for a mixed photo + video post', () => {
    expect(chooseMethod([photo('a'), video('b')])).toBe('sendMediaGroup');
  });

  it('reports "none" when there is no media', () => {
    expect(chooseMethod([])).toBe('none');
  });
});

describe('processPost publishing', () => {
  it('publishes one photo via sendPhoto', async () => {
    const { fetchImpl, telegramCalls } = makeFetch();

    const outcome = await withEnv({ DRY_RUN: 'false' }, (env) =>
      processPost(makePost([photo('a')]), {
        client: makeClient(fetchImpl),
        logger: createTestLogger(),
        env,
        fetchImpl,
        sleep: instantSleep,
      }),
    );

    expect(outcome.status).toBe('published');
    expect(outcome.method).toBe('sendPhoto');
    expect(outcome.primaryMessageId).toBe(100);
    expect(telegramCalls.map((c) => c.method)).toEqual(['sendPhoto']);
  });

  it('publishes one video via sendVideo with streaming metadata', async () => {
    const { fetchImpl, telegramCalls } = makeFetch();

    const outcome = await withEnv({ DRY_RUN: 'false' }, (env) =>
      processPost(makePost([video('a')]), {
        client: makeClient(fetchImpl),
        logger: createTestLogger(),
        env,
        fetchImpl,
        sleep: instantSleep,
      }),
    );

    expect(outcome.status).toBe('published');
    expect(outcome.method).toBe('sendVideo');

    const form = telegramCalls[0]!.body as FormData;
    expect(form.get('supports_streaming')).toBe('true');
    expect(form.get('width')).toBe('1280');
    expect(form.get('height')).toBe('720');
    expect(form.get('duration')).toBe('30');
  });

  it('publishes four photos as a single album', async () => {
    const { fetchImpl, telegramCalls } = makeFetch();

    const outcome = await withEnv({ DRY_RUN: 'false' }, (env) =>
      processPost(makePost([photo('a'), photo('b'), photo('c'), photo('d')]), {
        client: makeClient(fetchImpl),
        logger: createTestLogger(),
        env,
        fetchImpl,
        sleep: instantSleep,
      }),
    );

    expect(outcome.status).toBe('published');
    expect(outcome.method).toBe('sendMediaGroup');
    expect(telegramCalls).toHaveLength(1);
    expect(telegramCalls[0]!.method).toBe('sendMediaGroup');

    const form = telegramCalls[0]!.body as FormData;
    const descriptors = JSON.parse(form.get('media') as string) as Record<string, unknown>[];
    expect(descriptors).toHaveLength(4);
    expect(descriptors.every((d) => d.type === 'photo')).toBe(true);
    expect(descriptors.every((d, i) => d.media === `attach://file_${i}`)).toBe(true);
  });

  it('attaches the caption to the first album item only', async () => {
    const { fetchImpl, telegramCalls } = makeFetch();

    await withEnv({ DRY_RUN: 'false' }, (env) =>
      processPost(makePost([photo('a'), photo('b'), photo('c')]), {
        client: makeClient(fetchImpl),
        logger: createTestLogger(),
        env,
        fetchImpl,
        sleep: instantSleep,
      }),
    );

    const form = telegramCalls[0]!.body as FormData;
    const descriptors = JSON.parse(form.get('media') as string) as Record<string, unknown>[];

    expect(descriptors[0]!.caption).toContain('Hello world');
    expect(descriptors[0]!.parse_mode).toBe('HTML');
    expect(descriptors[1]!.caption).toBeUndefined();
    expect(descriptors[2]!.caption).toBeUndefined();
  });

  it('records every message id returned for an album', async () => {
    const { fetchImpl } = makeFetch();

    const outcome = await withEnv({ DRY_RUN: 'false' }, (env) =>
      processPost(makePost([photo('a'), photo('b')]), {
        client: makeClient(fetchImpl),
        logger: createTestLogger(),
        env,
        fetchImpl,
        sleep: instantSleep,
      }),
    );

    expect(outcome.messages.map((m) => m.messageId)).toEqual([100, 101]);
    expect(outcome.primaryMessageId).toBe(100);
  });

  it('marks a video in an album as streamable', async () => {
    const { fetchImpl, telegramCalls } = makeFetch();

    await withEnv({ DRY_RUN: 'false' }, (env) =>
      processPost(makePost([photo('a'), video('b')]), {
        client: makeClient(fetchImpl),
        logger: createTestLogger(),
        env,
        fetchImpl,
        sleep: instantSleep,
      }),
    );

    const form = telegramCalls[0]!.body as FormData;
    const descriptors = JSON.parse(form.get('media') as string) as Record<string, unknown>[];

    expect(descriptors[0]!.type).toBe('photo');
    expect(descriptors[1]!.type).toBe('video');
    expect(descriptors[1]!.supports_streaming).toBe(true);
  });

  it('sends a follow-up message when the text exceeds the caption limit', async () => {
    const { fetchImpl, telegramCalls } = makeFetch();

    const outcome = await withEnv({ DRY_RUN: 'false' }, (env) =>
      processPost(makePost([photo('a'), photo('b')], 'word '.repeat(400).trim()), {
        client: makeClient(fetchImpl),
        logger: createTestLogger(),
        env,
        fetchImpl,
        sleep: instantSleep,
      }),
    );

    expect(outcome.status).toBe('published');
    expect(telegramCalls.map((c) => c.method)).toEqual(['sendMediaGroup', 'sendMessage']);
    expect(outcome.messages.some((m) => m.kind === 'text')).toBe(true);
  });

  it('passes the URL instead of bytes when MEDIA_UPLOAD_MODE=url', async () => {
    const { fetchImpl, telegramCalls } = makeFetch();

    await withEnv({ DRY_RUN: 'false', MEDIA_UPLOAD_MODE: 'url' }, (env) =>
      processPost(makePost([photo('a')]), {
        client: makeClient(fetchImpl),
        logger: createTestLogger(),
        env,
        fetchImpl,
        sleep: instantSleep,
      }),
    );

    const body = JSON.parse(telegramCalls[0]!.body as string) as Record<string, unknown>;
    expect(body.photo).toContain('pbs.twimg.com');
  });
});

describe('processPost video variant selection', () => {
  const MB = 1024 * 1024;

  /** Video with three renditions; `sizes` maps each url to its byte size. */
  const multiVariantVideo = (): NormalizedMedia => ({
    mediaKey: '7_1',
    kind: 'video',
    url: 'https://video.twimg.com/high.mp4',
    width: 1280,
    height: 720,
    durationSeconds: 46,
    contentType: 'video/mp4',
    mp4Variants: [
      { url: 'https://video.twimg.com/high.mp4', bitRate: 2176000, contentType: 'video/mp4' },
      { url: 'https://video.twimg.com/mid.mp4', bitRate: 832000, contentType: 'video/mp4' },
      { url: 'https://video.twimg.com/low.mp4', bitRate: 256000, contentType: 'video/mp4' },
    ],
  });

  /** Telegram stub plus a CDN that reports per-url sizes on HEAD and GET. */
  function variantFetch(sizes: Record<string, number>) {
    const uploaded: string[] = [];

    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);

      if (url.includes('api.telegram.example')) {
        return telegramOk({ message_id: 100, chat: { id: -1001234567890 } });
      }

      const size = sizes[url];
      if (size === undefined) return new Response('not found', { status: 404 });

      if (init?.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'content-length': String(size) } });
      }

      uploaded.push(url);
      // Body is a token 64 bytes; content-length advertises the real size only
      // when it is within what the caller allows, mirroring a real CDN.
      return new Response(new Uint8Array(64), {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(Math.min(size, 64)) },
      });
    });

    return { fetchImpl: fetchImpl as unknown as typeof fetch, uploaded };
  }

  it('keeps the highest rendition when it fits the budget', async () => {
    const { fetchImpl, uploaded } = variantFetch({
      'https://video.twimg.com/high.mp4': 8 * MB,
      'https://video.twimg.com/mid.mp4': 3 * MB,
      'https://video.twimg.com/low.mp4': 1 * MB,
    });

    const outcome = await withEnv({ DRY_RUN: 'false', MAX_VIDEO_SIZE_MB: '10' }, (env) =>
      processPost(makePost([multiVariantVideo()]), {
        client: makeClient(fetchImpl),
        logger: createTestLogger(),
        env,
        fetchImpl,
        sleep: instantSleep,
      }),
    );

    expect(outcome.status).toBe('published');
    expect(uploaded).toEqual(['https://video.twimg.com/high.mp4']);
  });

  it('publishes a smaller rendition instead of skipping an oversized video', async () => {
    const { fetchImpl, uploaded } = variantFetch({
      'https://video.twimg.com/high.mp4': 24 * MB,
      'https://video.twimg.com/mid.mp4': 7 * MB,
      'https://video.twimg.com/low.mp4': 2 * MB,
    });

    const logger = createTestLogger();
    const outcome = await withEnv({ DRY_RUN: 'false', MAX_VIDEO_SIZE_MB: '10' }, (env) =>
      processPost(makePost([multiVariantVideo()]), {
        client: makeClient(fetchImpl),
        logger,
        env,
        fetchImpl,
        sleep: instantSleep,
      }),
    );

    // Previously this post was skipped as "too large"; now it goes out.
    expect(outcome.status).toBe('published');
    expect(uploaded).toEqual(['https://video.twimg.com/mid.mp4']);

    const downgrade = logger.entries.find((e) => e.event === 'video.variant_downgraded');
    expect(downgrade?.data).toMatchObject({ toBitRate: 832000 });
  });

  it('never downloads a rendition that is over budget', async () => {
    const { fetchImpl, uploaded } = variantFetch({
      'https://video.twimg.com/high.mp4': 24 * MB,
      'https://video.twimg.com/mid.mp4': 7 * MB,
      'https://video.twimg.com/low.mp4': 2 * MB,
    });

    await withEnv({ DRY_RUN: 'false', MAX_VIDEO_SIZE_MB: '10' }, (env) =>
      processPost(makePost([multiVariantVideo()]), {
        client: makeClient(fetchImpl),
        logger: createTestLogger(),
        env,
        fetchImpl,
        sleep: instantSleep,
      }),
    );

    expect(uploaded).not.toContain('https://video.twimg.com/high.mp4');
  });

  it('honours a tighter MAX_VIDEO_SIZE_MB than Telegram would allow', async () => {
    const { fetchImpl, uploaded } = variantFetch({
      'https://video.twimg.com/high.mp4': 24 * MB,
      'https://video.twimg.com/mid.mp4': 7 * MB,
      'https://video.twimg.com/low.mp4': 2 * MB,
    });

    await withEnv({ DRY_RUN: 'false', MAX_VIDEO_SIZE_MB: '5' }, (env) =>
      processPost(makePost([multiVariantVideo()]), {
        client: makeClient(fetchImpl),
        logger: createTestLogger(),
        env,
        fetchImpl,
        sleep: instantSleep,
      }),
    );

    expect(uploaded).toEqual(['https://video.twimg.com/low.mp4']);
  });

  it('posts the original when no rendition meets the preferred budget', async () => {
    // Everything is over 10 MB, but the original is within Telegram's limit:
    // a large original beats a skipped post.
    const { fetchImpl, uploaded } = variantFetch({
      'https://video.twimg.com/high.mp4': 34 * MB,
      'https://video.twimg.com/mid.mp4': 22 * MB,
      'https://video.twimg.com/low.mp4': 14 * MB,
    });

    const outcome = await withEnv(
      { DRY_RUN: 'false', PREFERRED_VIDEO_SIZE_MB: '10', MAX_VIDEO_SIZE_MB: '50' },
      (env) =>
        processPost(makePost([multiVariantVideo()]), {
          client: makeClient(fetchImpl),
          logger: createTestLogger(),
          env,
          fetchImpl,
          sleep: instantSleep,
        }),
    );

    expect(outcome.status).toBe('published');
    expect(uploaded).toEqual(['https://video.twimg.com/high.mp4']);
  });

  it('prefers a rendition under the preferred budget when one exists', async () => {
    const { fetchImpl, uploaded } = variantFetch({
      'https://video.twimg.com/high.mp4': 34 * MB,
      'https://video.twimg.com/mid.mp4': 8 * MB,
      'https://video.twimg.com/low.mp4': 2 * MB,
    });

    await withEnv(
      { DRY_RUN: 'false', PREFERRED_VIDEO_SIZE_MB: '10', MAX_VIDEO_SIZE_MB: '50' },
      (env) =>
        processPost(makePost([multiVariantVideo()]), {
          client: makeClient(fetchImpl),
          logger: createTestLogger(),
          env,
          fetchImpl,
          sleep: instantSleep,
        }),
    );

    expect(uploaded).toEqual(['https://video.twimg.com/mid.mp4']);
  });

  it('skips with a precise reason when no rendition fits', async () => {
    const { fetchImpl, uploaded } = variantFetch({
      'https://video.twimg.com/high.mp4': 40 * MB,
      'https://video.twimg.com/mid.mp4': 25 * MB,
      'https://video.twimg.com/low.mp4': 14 * MB,
    });

    const outcome = await withEnv({ DRY_RUN: 'false', MAX_VIDEO_SIZE_MB: '10' }, (env) =>
      processPost(makePost([multiVariantVideo()]), {
        client: makeClient(fetchImpl),
        logger: createTestLogger(),
        env,
        fetchImpl,
        sleep: instantSleep,
      }),
    );

    expect(outcome.status).toBe('skipped');
    expect(outcome.permanent).toBe(true);
    expect(outcome.error).toMatch(/all 3 MP4 variant\(s\).*smallest is 14\.0 MB/);
    expect(uploaded).toHaveLength(0);
  });

  it('leaves a single-variant video on the original path', async () => {
    const single: NormalizedMedia = {
      ...multiVariantVideo(),
      mp4Variants: [
        { url: 'https://video.twimg.com/high.mp4', bitRate: 2176000, contentType: 'video/mp4' },
      ],
    };

    const { fetchImpl, uploaded } = variantFetch({ 'https://video.twimg.com/high.mp4': 3 * MB });

    const outcome = await withEnv({ DRY_RUN: 'false', MAX_VIDEO_SIZE_MB: '10' }, (env) =>
      processPost(makePost([single]), {
        client: makeClient(fetchImpl),
        logger: createTestLogger(),
        env,
        fetchImpl,
        sleep: instantSleep,
      }),
    );

    expect(outcome.status).toBe('published');
    expect(uploaded).toEqual(['https://video.twimg.com/high.mp4']);
    // One variant means no probing is worthwhile.
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
      ([, init]) => (init as RequestInit | undefined)?.method === 'HEAD',
    )).toBe(false);
  });
});

describe('processPost failure handling', () => {
  it('skips a photo whose dimensions Telegram would reject, without uploading', async () => {
    const { fetchImpl, telegramCalls } = makeFetch();
    const oversized: NormalizedMedia = { ...photo('a'), width: 9000, height: 9000 };

    const outcome = await withEnv({ DRY_RUN: 'false' }, (env) =>
      processPost(makePost([oversized]), {
        client: makeClient(fetchImpl),
        logger: createTestLogger(),
        env,
        fetchImpl,
        sleep: instantSleep,
      }),
    );

    expect(outcome.status).toBe('skipped');
    expect(outcome.permanent).toBe(true);
    expect(outcome.error).toMatch(/width \+ height/);
    expect(telegramCalls).toHaveLength(0);
  });

  it('skips a video that exceeds the 50 MB upload limit', async () => {
    const fetchImpl = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('api.telegram.example')) return telegramOk({ message_id: 1, chat: { id: -100 } });
      return new Response(new Uint8Array(16), {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(60 * 1024 * 1024) },
      });
    }) as unknown as typeof fetch;

    const outcome = await withEnv({ DRY_RUN: 'false' }, (env) =>
      processPost(makePost([video('big')]), {
        client: makeClient(fetchImpl),
        logger: createTestLogger(),
        env,
        fetchImpl,
        sleep: instantSleep,
      }),
    );

    expect(outcome.status).toBe('skipped');
    expect(outcome.permanent).toBe(true);
    expect(outcome.error).toMatch(/above Telegram's 50\.0 MB limit/);
  });

  it('publishes nothing when one item of an album fails to download', async () => {
    const telegramMethods: string[] = [];
    const fetchImpl = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('api.telegram.example')) {
        telegramMethods.push(url.split('/').pop()!);
        return telegramOk([{ message_id: 1, chat: { id: -100 } }]);
      }
      // The second asset is permanently gone.
      if (url.includes('b.jpg')) return new Response('not found', { status: 404 });
      return new Response(new Uint8Array(32), {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': '32' },
      });
    }) as unknown as typeof fetch;

    const outcome = await withEnv({ DRY_RUN: 'false' }, (env) =>
      processPost(makePost([photo('a'), photo('b')]), {
        client: makeClient(fetchImpl),
        logger: createTestLogger(),
        env,
        fetchImpl,
        sleep: instantSleep,
      }),
    );

    // All-or-nothing: no partial album may reach the channel.
    expect(outcome.status).toBe('failed');
    expect(telegramMethods).toHaveLength(0);
  });

  it('reports failed (retryable) when Telegram is temporarily unavailable', async () => {
    const { fetchImpl } = makeFetch({
      telegram: () => telegramError(503, 'Service Unavailable'),
    });

    const outcome = await withEnv({ DRY_RUN: 'false' }, (env) =>
      processPost(makePost([photo('a')]), {
        client: makeClient(fetchImpl),
        logger: createTestLogger(),
        env,
        fetchImpl,
        sleep: instantSleep,
      }),
    );

    expect(outcome.status).toBe('failed');
    expect(outcome.permanent).toBeFalsy();
  });

  it('reports skipped (permanent) when the bot lacks posting rights', async () => {
    const { fetchImpl } = makeFetch({
      telegram: () => telegramError(400, 'Bad Request: not enough rights to send photos to the chat'),
    });

    const outcome = await withEnv({ DRY_RUN: 'false' }, (env) =>
      processPost(makePost([photo('a')]), {
        client: makeClient(fetchImpl),
        logger: createTestLogger(),
        env,
        fetchImpl,
        sleep: instantSleep,
      }),
    );

    expect(outcome.status).toBe('skipped');
    expect(outcome.permanent).toBe(true);
  });

  it('still counts the post as published when only the overflow message fails', async () => {
    const { fetchImpl } = makeFetch({
      telegram: (method) =>
        method === 'sendMessage'
          ? telegramError(400, 'Bad Request: message is too long')
          : telegramOk([{ message_id: 100, chat: { id: -100 } }]),
    });

    const outcome = await withEnv({ DRY_RUN: 'false' }, (env) =>
      processPost(makePost([photo('a'), photo('b')], 'word '.repeat(400).trim()), {
        client: makeClient(fetchImpl),
        logger: createTestLogger(),
        env,
        fetchImpl,
        sleep: instantSleep,
      }),
    );

    // The album is already in the channel; retrying would duplicate it.
    expect(outcome.status).toBe('published');
  });
});

describe('processPost dry run', () => {
  it('resolves media and caption but sends nothing', async () => {
    const { fetchImpl, telegramCalls } = makeFetch();
    const logger = createTestLogger();

    const outcome = await withEnv({ DRY_RUN: 'true' }, (env) =>
      processPost(makePost([photo('a'), photo('b'), photo('c')]), {
        client: makeClient(fetchImpl),
        logger,
        env,
        fetchImpl,
        sleep: instantSleep,
      }),
    );

    expect(outcome.status).toBe('dry-run');
    expect(outcome.method).toBe('sendMediaGroup');
    expect(outcome.caption).toContain('Hello world');
    expect(telegramCalls).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();

    const entry = logger.entries.find((e) => e.event === 'dry_run.post');
    expect(entry?.data).toMatchObject({
      telegramMethod: 'sendMediaGroup',
      media: '3 photos',
      wouldPublish: true,
    });
  });
});
