import { describe, expect, it, vi } from 'vitest';
import { chooseMethod, processPost } from '@/lib/sync/process-post';
import { TelegramClient } from '@/lib/telegram/client';
import { parsePostFooter } from '@/lib/telegram/post-footer';
import type { NormalizedMedia, NormalizedPost } from '@/types';
import { createTestLogger, instantSleep, telegramError, telegramOk, withEnv, testDestination } from './helpers';

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
        destination: testDestination(env),
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
        destination: testDestination(env),
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
        destination: testDestination(env),
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
        destination: testDestination(env),
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
        destination: testDestination(env),
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
        destination: testDestination(env),
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
        destination: testDestination(env),
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
        destination: testDestination(env),
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
        destination: testDestination(env),
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
        destination: testDestination(env),
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
        destination: testDestination(env),
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
        destination: testDestination(env),
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
          destination: testDestination(env),
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
          destination: testDestination(env),
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
        destination: testDestination(env),
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
        destination: testDestination(env),
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
        destination: testDestination(env),
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
        destination: testDestination(env),
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
        destination: testDestination(env),
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
        destination: testDestination(env),
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
        destination: testDestination(env),
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
        destination: testDestination(env),
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
        destination: testDestination(env),
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

describe('processPost text-only posts', () => {
  const run = (
    post: NormalizedPost,
    options: { textOnly?: boolean; env?: Record<string, string | undefined> } = {},
  ) => {
    const stack = makeFetch();
    return withEnv({ DRY_RUN: 'false', ...options.env }, async (env) => ({
      ...stack,
      outcome: await processPost(post, {
        client: makeClient(stack.fetchImpl),
        logger: createTestLogger(),
        env,
        fetchImpl: stack.fetchImpl,
        sleep: instantSleep,
        postId: 7,
        destination: testDestination(env, { adminChatId: '555001' }),
        textOnly: options.textOnly,
      }),
    }));
  };

  const bodyOf = (call: { body: FormData | string }) =>
    JSON.parse(call.body as string) as Record<string, unknown>;

  it('still skips a post without media for a source that does not mirror text', async () => {
    const { outcome, telegramCalls } = await run(makePost([], 'Just words'));

    expect(outcome.status).toBe('skipped');
    expect(outcome.error).toBe('post has no usable media');
    expect(telegramCalls).toHaveLength(0);
  });

  it('publishes it to the channel as one text message', async () => {
    const { outcome, telegramCalls } = await run(makePost([], 'Just words & more'), { textOnly: true });

    expect(outcome.status).toBe('published');
    expect(outcome.method).toBe('sendMessage');
    expect(outcome.mediaCount).toBe(0);
    expect(outcome.primaryMessageId).toBe(100);
    expect(outcome.messages).toEqual([{ messageId: 100, mediaIndex: null, kind: 'text' }]);

    expect(telegramCalls.map((call) => call.method)).toEqual(['sendMessage']);
    const body = bodyOf(telegramCalls[0]!);
    expect(body.chat_id).toBe(process.env.TELEGRAM_CHAT_ID);
    expect(body.text).toContain('Just words &amp; more');
    expect(body.text).toContain('Source: https://x.com/testaccount/status/1234567890123456789');
    expect(outcome.caption).toBe(body.text);
  });

  it('sends it to the reviewer, with the buttons underneath, when approval is on', async () => {
    const { outcome, telegramCalls } = await run(makePost([], 'Just words'), {
      textOnly: true,
      env: { REQUIRE_APPROVAL: 'true', TELEGRAM_ADMIN_CHAT_ID: '555001', TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(64) },
    });

    expect(outcome.status).toBe('awaiting-approval');
    expect(telegramCalls.map((call) => call.method)).toEqual(['sendMessage', 'sendMessage']);
    expect(telegramCalls.every((call) => bodyOf(call).chat_id === '555001')).toBe(true);
    expect(bodyOf(telegramCalls[0]!).reply_markup).toBeUndefined();
    expect(bodyOf(telegramCalls[1]!).reply_markup).toBeDefined();

    expect(outcome.approval?.payload).toMatchObject({ method: 'sendMessage', items: [] });
    expect(outcome.approval?.payload.caption).toContain('Just words');
    expect(outcome.approval?.payload.overflowMessage).toBeUndefined();
  });

  it('leaves the source line out of a post under review: the buttons message links the original', async () => {
    const { outcome, telegramCalls } = await run(makePost([], 'Just words'), {
      textOnly: true,
      env: { REQUIRE_APPROVAL: 'true', TELEGRAM_ADMIN_CHAT_ID: '555001', TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(64) },
    });

    const url = 'https://x.com/testaccount/status/1234567890123456789';
    expect(bodyOf(telegramCalls[0]!).text).toBe('Just words');
    expect(outcome.approval?.payload.caption).toBe('Just words');
    expect(bodyOf(telegramCalls[1]!).text).toContain(url);
  });

  it('only logs it on a dry run', async () => {
    const { outcome, telegramCalls } = await run(makePost([], 'Just words'), {
      textOnly: true,
      env: { DRY_RUN: 'true' },
    });

    expect(outcome.status).toBe('dry-run');
    expect(outcome.method).toBe('sendMessage');
    expect(telegramCalls).toHaveLength(0);
  });

  it('shortens a text past the message limit, keeping the source link, with no follow-up', async () => {
    const { outcome, telegramCalls } = await run(makePost([], 'word '.repeat(2000).trim()), {
      textOnly: true,
    });

    expect(telegramCalls).toHaveLength(1);
    const text = bodyOf(telegramCalls[0]!).text as string;
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain('…');
    expect(text).toContain('Source: https://x.com/testaccount/status/1234567890123456789');
    expect(outcome.status).toBe('published');
  });

  it('never sends an empty message', async () => {
    const { outcome, telegramCalls } = await run(makePost([], ''), { textOnly: true });

    expect(outcome.status).toBe('skipped');
    expect(telegramCalls).toHaveLength(0);
  });
});

describe('processPost beforeReview hook', () => {
  const approval = {
    REQUIRE_APPROVAL: 'true',
    TELEGRAM_ADMIN_CHAT_ID: '555001',
    TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(64),
  };

  const run = (
    post: NormalizedPost,
    hook: (sentSoFar: number) => Promise<void>,
    env: Record<string, string | undefined>,
  ) => {
    const stack = makeFetch();
    return withEnv({ DRY_RUN: 'false', ...env }, async (parsed) => ({
      ...stack,
      outcome: await processPost(post, {
        client: makeClient(stack.fetchImpl),
        logger: createTestLogger(),
        env: parsed,
        fetchImpl: stack.fetchImpl,
        sleep: instantSleep,
        postId: 7,
        destination: testDestination(parsed, { adminChatId: '555001' }),
        textOnly: true,
        beforeReview: () => hook(stack.telegramCalls.length),
      }),
    }));
  };

  it('runs before anything is sent to the reviewer, for a media post and a text post', async () => {
    for (const post of [makePost([photo('a')]), makePost([], 'Just words')]) {
      const seen: number[] = [];
      const { outcome, telegramCalls } = await run(post, async (sent) => void seen.push(sent), approval);

      expect(seen).toEqual([0]);
      expect(telegramCalls.length).toBeGreaterThan(0);
      expect(outcome.status).toBe('awaiting-approval');
    }
  });

  it('does not run when the post goes straight to the channel, or on a dry run', async () => {
    const hook = vi.fn(async () => {});

    await run(makePost([photo('a')]), hook, {});
    await run(makePost([photo('a')]), hook, { ...approval, DRY_RUN: 'true' });
    await run(makePost([], 'Just words'), hook, { ...approval, DRY_RUN: 'true' });

    expect(hook).not.toHaveBeenCalled();
  });

  it('sends the post for review even if the hook throws', async () => {
    const { outcome } = await run(
      makePost([photo('a')]),
      async () => {
        throw new Error('radar exploded');
      },
      approval,
    );

    expect(outcome.status).toBe('awaiting-approval');
  });
});

describe('processPost translation', () => {
  const approval = {
    REQUIRE_APPROVAL: 'true',
    TELEGRAM_ADMIN_CHAT_ID: '555001',
    TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(64),
  };

  const run = (
    post: NormalizedPost,
    options: {
      translate?: (text: string) => Promise<string | null>;
      beforeReview?: () => Promise<void>;
      env?: Record<string, string | undefined>;
    },
  ) => {
    const stack = makeFetch();
    return withEnv({ DRY_RUN: 'false', ...options.env }, async (parsed) => ({
      ...stack,
      outcome: await processPost(post, {
        client: makeClient(stack.fetchImpl),
        logger: createTestLogger(),
        env: parsed,
        fetchImpl: stack.fetchImpl,
        sleep: instantSleep,
        postId: 7,
        destination: testDestination(parsed, { adminChatId: '555001' }),
        textOnly: true,
        translate: options.translate,
        beforeReview: options.beforeReview,
      }),
    }));
  };

  const sentText = (call: { body: FormData | string }) =>
    typeof call.body === 'string'
      ? ((JSON.parse(call.body) as { text?: string; caption?: string }).text ?? '')
      : String(call.body.get('caption') ?? '');

  it('sends the reviewer the translated caption', async () => {
    const { outcome, telegramCalls } = await run(makePost([photo('a')], 'A rare photo of Saturn'), {
      translate: async (text) => (text === 'A rare photo of Saturn' ? 'Рідкісне фото Сатурна' : null),
      env: approval,
    });

    expect(outcome.status).toBe('awaiting-approval');
    expect(sentText(telegramCalls[0]!)).toContain('Рідкісне фото Сатурна');
    expect(sentText(telegramCalls[0]!)).not.toContain('A rare photo');
    expect(outcome.caption).toBe('Рідкісне фото Сатурна');
    // What approval publishes is what was reviewed.
    expect(outcome.approval?.payload.caption).toBe(outcome.caption);
  });

  it('translates a text-only post too, and the one published straight to the channel', async () => {
    const review = await run(makePost([], 'Just words'), { translate: async () => 'Просто слова', env: approval });
    expect(review.outcome.approval?.payload.caption).toContain('Просто слова');

    const direct = await run(makePost([photo('a')], 'Hello'), { translate: async () => 'Привіт' });
    expect(direct.outcome.status).toBe('published');
    expect(sentText(direct.telegramCalls[0]!)).toContain('Привіт');
  });

  it('scores the original while it translates, neither waiting for the other', async () => {
    const events: string[] = [];
    const { outcome } = await run(makePost([photo('a')], 'Hello'), {
      translate: async () => {
        events.push('translate:start');
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push('translate:end');
        return 'Привіт';
      },
      beforeReview: async () => {
        events.push('radar:start');
      },
      env: approval,
    });

    expect(events.indexOf('radar:start')).toBeLessThan(events.indexOf('translate:end'));
    expect(outcome.caption).toContain('Привіт');
  });

  it('keeps the original text when translation fails or has nothing to say', async () => {
    for (const translate of [
      async () => {
        throw new Error('model down');
      },
      async () => null,
    ]) {
      const { outcome } = await run(makePost([photo('a')], 'A rare photo of Saturn'), { translate, env: approval });

      expect(outcome.status).toBe('awaiting-approval');
      expect(outcome.caption).toContain('A rare photo of Saturn');
    }
  });

  it('pays for no translation of a post that is skipped, or on a dry run', async () => {
    const translate = vi.fn(async () => 'Привіт');

    await run(makePost([photo('a')], 'Hello'), { translate, env: { ...approval, DRY_RUN: 'true' } });
    const tooWide = { ...photo('w'), width: 9000, height: 100 };
    const skipped = await run(makePost([tooWide], 'Hello'), { translate, env: approval });

    expect(skipped.outcome.status).toBe('skipped');
    expect(translate).not.toHaveBeenCalled();
  });
});

describe('processPost footer', () => {
  const footer = parsePostFooter('[ВЕКТОР](https://t.me/vector_space2035)');
  const link = '<a href="https://t.me/vector_space2035">ВЕКТОР</a>';

  const run = (post: NormalizedPost, env: Record<string, string | undefined> = {}) => {
    const stack = makeFetch();
    return withEnv({ DRY_RUN: 'false', ...env }, async (parsed) => ({
      ...stack,
      outcome: await processPost(post, {
        client: makeClient(stack.fetchImpl),
        logger: createTestLogger(),
        env: parsed,
        fetchImpl: stack.fetchImpl,
        sleep: instantSleep,
        postId: 7,
        destination: testDestination(parsed, { adminChatId: '555001' }),
        textOnly: true,
        footer,
        translate: async () => 'Переклад',
      }),
    }));
  };

  it('goes under the reviewed caption, below the translation, as a working link', async () => {
    const { outcome } = await run(makePost([photo('a')], 'Hello'), {
      REQUIRE_APPROVAL: 'true',
      TELEGRAM_ADMIN_CHAT_ID: '555001',
      TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(64),
    });

    expect(outcome.approval?.payload.caption.startsWith('Переклад')).toBe(true);
    expect(outcome.approval?.payload.caption.endsWith(link)).toBe(true);
  });

  it('reaches the channel as a link under a long post’s follow-up too, never as escaped markup', async () => {
    const stack = makeFetch();
    const post = makePost([photo('a')], 'word '.repeat(400));
    const outcome = await withEnv({ DRY_RUN: 'false' }, async (parsed) =>
      processPost(post, {
        client: makeClient(stack.fetchImpl),
        logger: createTestLogger(),
        env: parsed,
        fetchImpl: stack.fetchImpl,
        sleep: instantSleep,
        postId: 7,
        destination: testDestination(parsed),
        footer,
      }),
    );

    expect(outcome.status).toBe('published');
    const followUp = stack.telegramCalls.find((call) => call.method === 'sendMessage')!;
    const text = (JSON.parse(followUp.body as string) as { text: string }).text;
    expect(text.endsWith(link)).toBe(true);
    expect(text).not.toContain('&lt;a');
  });
});
