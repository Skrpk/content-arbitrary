import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { TelegramClient, telegramMessageSchema } from '@/lib/telegram/client';
import { TelegramApiError } from '@/lib/errors';
import { instantSleep, telegramError, telegramOk } from './helpers';

function makeClient(fetchImpl: typeof fetch, attempts = 5) {
  return new TelegramClient({
    token: '123456:TEST',
    baseUrl: 'https://api.telegram.example',
    fetchImpl,
    attempts,
    sleep: instantSleep,
  });
}

const message = { message_id: 42, chat: { id: -1001234567890 } };

describe('TelegramClient.call', () => {
  it('parses a successful response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(telegramOk(message));
    const result = await makeClient(fetchImpl as never).call(
      'sendMessage',
      { chat_id: '-100', text: 'hi' },
      telegramMessageSchema,
    );

    expect(result.message_id).toBe(42);
  });

  it('posts JSON for a plain object body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(telegramOk(message));
    await makeClient(fetchImpl as never).call('sendMessage', { chat_id: '-100' }, telegramMessageSchema);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.example/bot123456:TEST/sendMessage');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('posts multipart without overriding the content-type boundary', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(telegramOk(message));
    const form = new FormData();
    form.set('chat_id', '-100');

    await makeClient(fetchImpl as never).call('sendPhoto', form, telegramMessageSchema);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
  });
});

describe('429 / flood control', () => {
  it('waits exactly the retry_after Telegram asks for, then succeeds', async () => {
    const delays: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(telegramError(429, 'Too Many Requests: retry after 12', { retry_after: 12 }))
      .mockResolvedValueOnce(telegramOk(message));

    const client = new TelegramClient({
      token: '123456:TEST',
      baseUrl: 'https://api.telegram.example',
      fetchImpl: fetchImpl as never,
      attempts: 5,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    const result = await client.call('sendMessage', { chat_id: '-100' }, telegramMessageSchema);

    expect(result.message_id).toBe(42);
    expect(delays).toEqual([12_000]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('defaults to one second when retry_after is absent', async () => {
    const delays: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(telegramError(429, 'Too Many Requests'))
      .mockResolvedValueOnce(telegramOk(message));

    const client = new TelegramClient({
      token: '123456:TEST',
      baseUrl: 'https://api.telegram.example',
      fetchImpl: fetchImpl as never,
      attempts: 3,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    await client.call('sendMessage', { chat_id: '-100' }, telegramMessageSchema);
    expect(delays).toEqual([1000]);
  });

  it('does not retry a flood wait longer than the two-minute ceiling', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () =>
        telegramError(429, 'Too Many Requests: retry after 3600', { retry_after: 3600 }),
      );

    await expect(
      makeClient(fetchImpl as never).call('sendMessage', { chat_id: '-100' }, telegramMessageSchema),
    ).rejects.toThrow(/rate limited/i);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('error classification', () => {
  it('retries a 500 and recovers', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(telegramError(500, 'Internal Server Error'))
      .mockResolvedValueOnce(telegramOk(message));

    const result = await makeClient(fetchImpl as never).call(
      'sendMessage',
      { chat_id: '-100' },
      telegramMessageSchema,
    );

    expect(result.message_id).toBe(42);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries on a persistent 5xx', async () => {
    // A fresh Response per call: a Response body can only be read once, and
    // real fetch hands back a new object each time.
    const fetchImpl = vi.fn().mockImplementation(async () => telegramError(502, 'Bad Gateway'));

    await expect(
      makeClient(fetchImpl as never, 3).call('sendMessage', { chat_id: '-100' }, telegramMessageSchema),
    ).rejects.toThrow(/Bad Gateway/);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['chat not found', 'Bad Request: chat not found'],
    ['missing admin rights', 'Bad Request: not enough rights to send photos to the chat'],
    ['kicked from channel', 'Forbidden: bot was kicked from the channel chat'],
    ['oversized file', 'Request Entity Too Large: file is too big'],
    ['broken markup', "Bad Request: can't parse entities: unsupported start tag"],
  ])('treats "%s" as permanent and does not retry', async (_label, description) => {
    const fetchImpl = vi.fn().mockImplementation(async () => telegramError(400, description));

    await expect(
      makeClient(fetchImpl as never).call('sendPhoto', { chat_id: '-100' }, telegramMessageSchema),
    ).rejects.toBeInstanceOf(TelegramApiError);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-JSON body without crashing', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => new Response('<html>gateway timeout</html>', { status: 504 }));

    await expect(
      makeClient(fetchImpl as never, 2).call('sendMessage', { chat_id: '-100' }, telegramMessageSchema),
    ).rejects.toThrow(/non-JSON/);
  });

  it('rejects a result that does not match the expected shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(telegramOk({ unexpected: true }));

    await expect(
      makeClient(fetchImpl as never).call('sendMessage', { chat_id: '-100' }, telegramMessageSchema),
    ).rejects.toThrow(/Unexpected Telegram result/);
  });

  it('validates an array result for sendMediaGroup', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(telegramOk([message, { message_id: 43, chat: { id: -100 } }]));

    const result = await makeClient(fetchImpl as never).call(
      'sendMediaGroup',
      { chat_id: '-100' },
      z.array(telegramMessageSchema),
    );

    expect(result.map((m) => m.message_id)).toEqual([42, 43]);
  });
});
