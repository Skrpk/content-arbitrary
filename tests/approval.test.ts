import { describe, expect, it, vi } from 'vitest';
import {
  buildApprovalKeyboard,
  buildEditUrl,
  buildCallbackData,
  buildRejectReasonCallbackData,
  buildRejectNoteUrl,
  buildRejectReasonKeyboard,
  formatRejectionNotice,
  parseCallbackData,
  publishApprovedPayload,
  sendForApproval,
} from '@/lib/sync/approval';
import { TelegramClient, mediaFileIdOf, telegramMessageSchema } from '@/lib/telegram/client';
import type { MediaPayload, SendContext } from '@/lib/telegram/send-media';
import { REJECTION_REASONS, type ApprovalPayload } from '@/db/schema';
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

    expect(keyboard.inline_keyboard).toHaveLength(1);
    expect(keyboard.inline_keyboard[0]).toEqual([
      { text: '✅ Approve', callback_data: 'ap:99' },
      { text: '🚫 Reject', callback_data: 'rj:99' },
    ]);
  });

  it('adds Edit as its own row when a Mini App URL is configured', () => {
    const keyboard = buildApprovalKeyboard(99, {
      editUrl: buildEditUrl('https://example.vercel.app', 99),
    });

    expect(keyboard.inline_keyboard).toHaveLength(2);
    // A separate row: Edit opens an editor, the other two settle the post.
    expect(keyboard.inline_keyboard[1]).toEqual([
      { text: '✏️ Edit text', web_app: { url: 'https://example.vercel.app/review?post=99' } },
    ]);
  });

  it('omits Edit entirely when no URL is configured', () => {
    // Review must keep working on a deployment that has not set APP_BASE_URL.
    const keyboard = buildApprovalKeyboard(99, { editUrl: undefined });
    expect(keyboard.inline_keyboard).toHaveLength(1);
  });

  it('builds an https Mini App URL without a double slash', () => {
    expect(buildEditUrl('https://example.vercel.app/', 7)).toBe(
      'https://example.vercel.app/review?post=7',
    );
  });
});

describe('rejection reasons', () => {
  /**
   * These strings are stored and will be grouped on. A rename would split one
   * reason's history in two, so this list changing should be a deliberate act.
   */
  it('keeps the stored values stable', () => {
    expect(REJECTION_REASONS).toEqual([
      'not_interesting',
      'wrong_topic',
      'already_covered',
      'too_minor',
      'weak_source',
      'other',
    ]);
  });

  it.each(REJECTION_REASONS)('round-trips the %s reason', (reason) => {
    const data = buildRejectReasonCallbackData(4321, reason);
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    expect(parseCallbackData(data)).toEqual({ action: 'reject_reason', postId: 4321, reason });
  });

  it('round-trips Back', () => {
    expect(parseCallbackData(buildCallbackData('reject_back', 7))).toEqual({
      action: 'reject_back',
      postId: 7,
    });
  });

  it.each([
    ['rr:12:bogus', 'unknown reason'],
    ['rr:12:', 'empty reason'],
    ['rr:12', 'no reason at all'],
    ['rr:12:Already_Covered', 'wrong case'],
    ['rr:0:other', 'zero id'],
    ['ap:12:other', 'a reason on Approve'],
    ['rj:12:other', 'a reason on the Reject that only opens the list'],
  ])('refuses %s (%s)', (data) => {
    expect(parseCallbackData(data)).toBeNull();
  });

  it('offers every reason once, plus a way back', () => {
    const keyboard = buildRejectReasonKeyboard(99);
    const buttons = keyboard.inline_keyboard.flat();
    const data = buttons.map((button) => ('callback_data' in button ? button.callback_data : null));

    expect(data).toEqual([
      ...REJECTION_REASONS.map((reason) => `rr:99:${reason}`),
      'rb:99',
    ]);
    // Nothing on this keyboard settles the post except a reason.
    expect(data).not.toContain('ap:99');
  });

  it('makes Other open the Mini App when there is one, and leaves the rest as buttons', () => {
    const otherUrl = buildRejectNoteUrl('https://example.vercel.app/', 99);
    expect(otherUrl).toBe('https://example.vercel.app/review/reject?post=99');

    const buttons = buildRejectReasonKeyboard(99, { otherUrl }).inline_keyboard.flat();
    const other = buttons.find((button) => button.text === '••• Other');

    expect(other).toEqual({ text: '••• Other', web_app: { url: otherUrl } });
    expect(buttons.filter((button) => 'web_app' in button)).toHaveLength(1);
    expect(buttons).toContainEqual({ text: '♻️ Already covered', callback_data: 'rr:99:already_covered' });
  });

  it('shows the reviewer\'s own words in the notice, escaped', () => {
    const notice = formatRejectionNotice({
      reason: 'other',
      note: '  <b>old</b> & stale  ',
      xPostUrl: 'https://x.com/a/status/1',
    });

    expect(notice).toBe(
      '🚫 Rejected\nReason: ••• Other\n“&lt;b&gt;old&lt;/b&gt; &amp; stale”\nhttps://x.com/a/status/1',
    );
    expect(formatRejectionNotice({ reason: 'too_minor', xPostUrl: 'u' })).toBe(
      '🚫 Rejected\nReason: 🤏 Too minor\nu',
    );
  });

  it('keeps every button within the callback_data limit for the largest id', () => {
    const buttons = buildRejectReasonKeyboard(999_999_999_999).inline_keyboard.flat();
    for (const button of buttons) {
      expect('callback_data' in button).toBe(true);
      if ('callback_data' in button) {
        expect(Buffer.byteLength(button.callback_data, 'utf8')).toBeLessThanOrEqual(64);
      }
    }
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

  it('previews the full-text follow-up of a long post, between the media and the buttons', async () => {
    const { fetchImpl, calls } = telegramRecorder((method, call) =>
      method === 'sendPhoto'
        ? { message_id: 30, chat: { id: 555001 }, photo: [{ file_id: 'LARGE', file_size: 900 }] }
        : { message_id: 40 + call, chat: { id: 555001 } },
    );

    const result = await sendForApproval(
      makeContext(fetchImpl),
      {
        postId: 42,
        xPostUrl: 'https://x.com/a/status/1',
        sourceUsername: 'karpathy',
        method: 'sendPhoto',
        caption: 'Short version…',
        overflowMessage: 'The whole long text &amp; more.',
        payloads: [urlPayload(photo)],
      },
      { logger: createTestLogger(), sleep: instantSleep },
    );

    expect(calls.map((c) => c.method)).toEqual(['sendPhoto', 'sendMessage', 'sendMessage']);

    // Exactly what the channel will receive as the second message, under the media.
    const overflow = calls[1]!.body;
    expect(overflow.text).toBe('The whole long text &amp; more.');
    expect(overflow.reply_markup).toBeUndefined();
    expect(overflow.reply_parameters).toMatchObject({ message_id: 30 });

    // The buttons stay on the last message, which is what a decision edits.
    expect(calls[2]!.body.reply_markup).toBeDefined();
    expect(result.adminMessageId).toBe(43);
    expect(result.payload.adminOverflowMessageId).toBe(42);
    expect(result.payload.overflowMessage).toBe('The whole long text &amp; more.');
  });

  it('still queues the post for review when the full-text preview fails', async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      const method = String(input).split('/').pop()!;
      const body = JSON.parse(String(init?.body ?? '{}')) as { reply_markup?: unknown };
      methods.push(method);
      if (method === 'sendPhoto') {
        return telegramOk({ message_id: 30, chat: { id: 1 }, photo: [{ file_id: 'LARGE', file_size: 9 }] });
      }
      if (!body.reply_markup) {
        return new Response(
          JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: message is too long' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return telegramOk({ message_id: 40, chat: { id: 1 } });
    });
    const logger = createTestLogger();

    const result = await sendForApproval(
      makeContext(fetchImpl as unknown as typeof fetch),
      {
        postId: 42,
        xPostUrl: 'https://x.com/a/status/1',
        sourceUsername: 'karpathy',
        method: 'sendPhoto',
        caption: 'Short…',
        overflowMessage: 'Long',
        payloads: [urlPayload(photo)],
      },
      { logger, sleep: instantSleep },
    );

    expect(methods).toEqual(['sendPhoto', 'sendMessage', 'sendMessage']);
    expect(result.adminMessageId).toBe(40);
    expect(result.payload.adminOverflowMessageId).toBeUndefined();
    // The follow-up itself is still published on Approve.
    expect(result.payload.overflowMessage).toBe('Long');
    expect(logger.entries.some((entry) => entry.event === 'approval.overflow_preview_failed')).toBe(true);
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
