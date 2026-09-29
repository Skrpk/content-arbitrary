import { describe, expect, it, vi } from 'vitest';
import {
  buildApprovalKeyboard,
  buildCallbackData,
  parseCallbackData,
  publishApprovedPayload,
  sendForApproval,
} from '@/lib/sync/approval';
import { TelegramClient, mediaFileIdOf, telegramMessageSchema } from '@/lib/telegram/client';
import type { MediaPayload, SendContext } from '@/lib/telegram/send-media';
import type { ApprovalPayload } from '@/db/schema';
import type { NormalizedMedia } from '@/types';
import { createTestLogger, instantSleep, telegramOk } from './helpers';

const photo: NormalizedMedia = {
  mediaKey: '3_1',
  kind: 'photo',
  url: 'https://pbs.twimg.com/media/a.jpg',
  width: 1200,
  height: 800,
};

const video: NormalizedMedia = {
  mediaKey: '7_1',
  kind: 'video',
  url: 'https://video.twimg.com/a.mp4',
  width: 1280,
  height: 720,
  durationSeconds: 30,
};

const urlPayload = (media: NormalizedMedia): MediaPayload => ({ mode: 'url', media });

function makeContext(fetchImpl: typeof fetch, chatId = '555001'): SendContext {
  return {
    client: new TelegramClient({
      token: '123456:TEST',
      baseUrl: 'https://api.telegram.example',
      fetchImpl,
      attempts: 2,
      sleep: instantSleep,
    }),
    chatId,
    disableNotification: false,
  };
}

/** Records every call and answers with realistic media-bearing messages. */
function telegramRecorder(responses?: (method: string, call: number) => unknown) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let count = 0;

  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const method = String(input).split('/').pop()!;
    count += 1;

    const raw = init?.body;
    const body =
      typeof raw === 'string'
        ? (JSON.parse(raw) as Record<string, unknown>)
        : Object.fromEntries((raw as FormData).entries());
    calls.push({ method, body });

    if (responses) return telegramOk(responses(method, count));

    if (method === 'sendMediaGroup') {
      return telegramOk([
        { message_id: 10, chat: { id: 555001 }, photo: [{ file_id: 'FILE_A', file_size: 100 }] },
        { message_id: 11, chat: { id: 555001 }, photo: [{ file_id: 'FILE_B', file_size: 100 }] },
      ]);
    }
    if (method === 'sendVideo') {
      return telegramOk({ message_id: 20, chat: { id: 555001 }, video: { file_id: 'VID_A' } });
    }
    if (method === 'sendPhoto') {
      return telegramOk({
        message_id: 30,
        chat: { id: 555001 },
        photo: [
          { file_id: 'SMALL', file_size: 10 },
          { file_id: 'LARGE', file_size: 900 },
        ],
      });
    }
    return telegramOk({ message_id: 40, chat: { id: 555001 } });
  });

  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe('callback data', () => {
  it('round-trips an approve action', () => {
    const data = buildCallbackData('approve', 42);
    expect(data).toBe('ap:42');
    expect(parseCallbackData(data)).toEqual({ action: 'approve', postId: 42 });
  });

  it('round-trips a reject action', () => {
    expect(parseCallbackData(buildCallbackData('reject', 7))).toEqual({
      action: 'reject',
      postId: 7,
    });
  });

  it('stays within the 64-byte callback_data limit', () => {
    const data = buildCallbackData('approve', 999_999_999_999);
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
  });

  it.each([
    ['', 'empty'],
    ['nonsense', 'unknown verb'],
    ['ap:', 'no id'],
    ['ap:abc', 'non-numeric id'],
    ['ap:0', 'zero id'],
    ['ap:-3', 'negative id'],
    ['xx:12', 'wrong verb'],
    ['ap:12;DROP TABLE', 'injection attempt'],
  ])('rejects malformed callback data: %s (%s)', (data) => {
    expect(parseCallbackData(data)).toBeNull();
  });

  it('rejects undefined data', () => {
    expect(parseCallbackData(undefined)).toBeNull();
  });

  it('builds a keyboard whose buttons carry the post id', () => {
    const keyboard = buildApprovalKeyboard(99);
    const [row] = keyboard.inline_keyboard;

    expect(row).toHaveLength(2);
    expect(row![0]!.callback_data).toBe('ap:99');
    expect(row![1]!.callback_data).toBe('rj:99');
  });
});

describe('mediaFileIdOf', () => {
  it('takes the largest photo rendition', () => {
    const message = telegramMessageSchema.parse({
      message_id: 1,
      chat: { id: 1 },
      photo: [
        { file_id: 'SMALL', file_size: 10 },
        { file_id: 'LARGE', file_size: 900 },
        { file_id: 'MID', file_size: 400 },
      ],
    });

    expect(mediaFileIdOf(message)).toBe('LARGE');
  });

  it('prefers a video file_id when present', () => {
    const message = telegramMessageSchema.parse({
      message_id: 1,
      chat: { id: 1 },
      video: { file_id: 'VID' },
    });

    expect(mediaFileIdOf(message)).toBe('VID');
  });

  it('returns undefined for a plain text message', () => {
    const message = telegramMessageSchema.parse({ message_id: 1, chat: { id: 1 } });
    expect(mediaFileIdOf(message)).toBeUndefined();
  });
});

describe('sendForApproval', () => {
  it('sends a single photo with the buttons attached to it', async () => {
    const { fetchImpl, calls } = telegramRecorder();

    const result = await sendForApproval(
      makeContext(fetchImpl),
      {
        postId: 42,
        xPostUrl: 'https://x.com/a/status/1',
        sourceUsername: 'karpathy',
        method: 'sendPhoto',
        caption: 'hello',
        payloads: [urlPayload(photo)],
      },
      { logger: createTestLogger(), sleep: instantSleep },
    );

    // Media first (exactly as the channel will see it), then the control
    // message that carries the source line and the buttons.
    expect(calls.map((c) => c.method)).toEqual(['sendPhoto', 'sendMessage']);
    expect(calls[0]!.body.reply_markup).toBeUndefined();
    expect(result.adminMessageId).toBe(40);
    expect(result.payload.items).toEqual([
      { kind: 'photo', fileId: 'LARGE', width: 1200, height: 800, durationSeconds: undefined },
    ]);

    const markup = calls[1]!.body.reply_markup as { inline_keyboard: unknown[][] };
    expect(markup.inline_keyboard[0]).toHaveLength(2);
    expect(calls[1]!.body.text).toContain('Source: @karpathy');
  });

  it('captures a video file_id', async () => {
    const { fetchImpl } = telegramRecorder();

    const result = await sendForApproval(
      makeContext(fetchImpl),
      {
        postId: 1,
        xPostUrl: 'https://x.com/a/status/1',
        sourceUsername: 'karpathy',
        method: 'sendVideo',
        caption: '',
        payloads: [urlPayload(video)],
      },
      { sleep: instantSleep },
    );

    expect(result.payload.items[0]).toMatchObject({ kind: 'video', fileId: 'VID_A' });
  });

  it('puts the buttons on a follow-up message for an album', async () => {
    // Telegram does not accept an inline keyboard on sendMediaGroup.
    const { fetchImpl, calls } = telegramRecorder();

    const result = await sendForApproval(
      makeContext(fetchImpl),
      {
        postId: 42,
        xPostUrl: 'https://x.com/a/status/1',
        sourceUsername: 'karpathy',
        method: 'sendMediaGroup',
        caption: 'album',
        payloads: [urlPayload(photo), urlPayload({ ...photo, mediaKey: '3_2' })],
      },
      { sleep: instantSleep },
    );

    expect(calls.map((c) => c.method)).toEqual(['sendMediaGroup', 'sendMessage']);
    expect(calls[0]!.body.reply_markup).toBeUndefined();
    expect(calls[1]!.body.reply_markup).toBeDefined();

    // Buttons live on the text message, which is what a decision must edit.
    expect(result.adminMessageId).toBe(40);
    expect(calls[1]!.body.text).toContain('Source: @karpathy');
    expect(result.payload.items.map((i) => i.fileId)).toEqual(['FILE_A', 'FILE_B']);
  });

  it('sends to the reviewer, not the channel', async () => {
    const { fetchImpl, calls } = telegramRecorder();

    await sendForApproval(
      makeContext(fetchImpl, '555001'),
      {
        postId: 1,
        xPostUrl: 'https://x.com/a/status/1',
        sourceUsername: 'karpathy',
        method: 'sendPhoto',
        caption: '',
        payloads: [urlPayload(photo)],
      },
      { sleep: instantSleep },
    );

    expect(calls[0]!.body.chat_id).toBe('555001');
  });

  it('records the caption and overflow for later publication', async () => {
    const { fetchImpl } = telegramRecorder();

    const result = await sendForApproval(
      makeContext(fetchImpl),
      {
        postId: 1,
        xPostUrl: 'https://x.com/a/status/1',
        sourceUsername: 'karpathy',
        method: 'sendPhoto',
        caption: 'short caption',
        overflowMessage: 'the full text',
        payloads: [urlPayload(photo)],
      },
      { sleep: instantSleep },
    );

    expect(result.payload).toMatchObject({
      method: 'sendPhoto',
      caption: 'short caption',
      overflowMessage: 'the full text',
    });
  });
});

describe('publishApprovedPayload', () => {
  const payload = (overrides?: Partial<ApprovalPayload>): ApprovalPayload => ({
    method: 'sendPhoto',
    caption: 'hello',
    items: [{ kind: 'photo', fileId: 'LARGE' }],
    ...overrides,
  });

  it('re-sends by file_id without downloading anything', async () => {
    const { fetchImpl, calls } = telegramRecorder();

    await publishApprovedPayload(makeContext(fetchImpl, '-1001234567890'), payload(), {
      sleep: instantSleep,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('sendPhoto');
    expect(calls[0]!.body.photo).toBe('LARGE');
    expect(calls[0]!.body.chat_id).toBe('-1001234567890');
  });

  it('publishes an album from stored file_ids', async () => {
    const { fetchImpl, calls } = telegramRecorder();

    const result = await publishApprovedPayload(
      makeContext(fetchImpl, '-100'),
      payload({
        method: 'sendMediaGroup',
        items: [
          { kind: 'photo', fileId: 'FILE_A' },
          { kind: 'photo', fileId: 'FILE_B' },
        ],
      }),
      { sleep: instantSleep },
    );

    // file_id sends take the JSON path, so `media` is already an array; the
    // multipart path would hand back a JSON string instead.
    const raw = calls[0]!.body.media;
    const descriptors = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<
      string,
      unknown
    >[];
    expect(descriptors.map((d) => d.media)).toEqual(['FILE_A', 'FILE_B']);
    expect(result.messages.map((m) => m.messageId)).toEqual([10, 11]);
  });

  it('carries video metadata through to the channel', async () => {
    const { fetchImpl, calls } = telegramRecorder();

    await publishApprovedPayload(
      makeContext(fetchImpl, '-100'),
      payload({
        method: 'sendVideo',
        items: [{ kind: 'video', fileId: 'VID_A', width: 1280, height: 720, durationSeconds: 30 }],
      }),
      { sleep: instantSleep },
    );

    expect(calls[0]!.body).toMatchObject({
      video: 'VID_A',
      supports_streaming: true,
      width: 1280,
      height: 720,
      duration: 30,
    });
  });

  it('sends the overflow text after the media', async () => {
    const { fetchImpl, calls } = telegramRecorder();

    await publishApprovedPayload(
      makeContext(fetchImpl, '-100'),
      payload({ overflowMessage: 'the rest of the text' }),
      { sleep: instantSleep },
    );

    expect(calls.map((c) => c.method)).toEqual(['sendPhoto', 'sendMessage']);
  });

  it('still reports success when only the overflow text fails', async () => {
    const { fetchImpl } = telegramRecorder((method) =>
      method === 'sendMessage' ? undefined : { message_id: 30, chat: { id: 1 } },
    );

    // sendMessage returns an unparsable result; the media is already published
    // so this must not throw and cause a duplicate on retry.
    await expect(
      publishApprovedPayload(makeContext(fetchImpl, '-100'), payload({ overflowMessage: 'tail' }), {
        logger: createTestLogger(),
        sleep: instantSleep,
      }),
    ).resolves.toMatchObject({ primaryMessageId: 30 });
  });

  it('throws when the payload has no media to publish', async () => {
    const { fetchImpl } = telegramRecorder();

    await expect(
      publishApprovedPayload(makeContext(fetchImpl, '-100'), payload({ items: [] }), {
        sleep: instantSleep,
      }),
    ).rejects.toThrow(/no media/);
  });
});
