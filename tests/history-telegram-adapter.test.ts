import { describe, expect, it } from 'vitest';
import {
  HistoryFormatError,
  parseTelegramExport,
  plainText,
  telegramJsonAdapter,
} from '@/lib/history/adapters/telegram-json';

/**
 * Fixtures follow what Telegram Desktop writes: see the field notes at the top
 * of the adapter.
 */
const channel = (messages: unknown[], header: Record<string, unknown> = {}) => ({
  name: 'VECTOR',
  type: 'public_channel',
  id: 1234567890,
  messages,
  ...header,
});

const message = (fields: Record<string, unknown>) => ({
  id: 1,
  type: 'message',
  date: '2026-03-18T14:00:00',
  date_unixtime: '1773842400',
  from: 'VECTOR',
  from_id: 'channel1234567890',
  text: '',
  text_entities: [],
  ...fields,
});

const fileOf = (content: string, name = 'result.json') => ({
  name,
  bytes: new TextEncoder().encode(content),
});

describe('Telegram JSON export → canonical items', () => {
  it('maps a plain-text message', () => {
    const parsed = parseTelegramExport(channel([message({ id: 42, text: 'Hello' })]));

    expect(parsed.platform).toBe('telegram');
    expect(parsed.publicationName).toBe('VECTOR');
    expect(parsed.itemsSeen).toBe(1);
    expect(parsed.items).toEqual([
      {
        externalId: '42',
        contentType: 'post',
        title: null,
        text: 'Hello',
        publishedAt: new Date(1773842400 * 1000),
        editedAt: null,
        canonicalUrl: null,
        media: [],
        metrics: null,
        metadata: { from: 'VECTOR', fromId: 'channel1234567890' },
      },
    ]);
  });

  it('keys a channel by its Bot API chat id', () => {
    expect(parseTelegramExport(channel([])).publicationKey).toBe('-1001234567890');
    expect(parseTelegramExport(channel([], { type: 'private_channel' })).publicationKey).toBe('-1001234567890');
  });

  it('falls back to the normalised name when the export has no id', () => {
    const parsed = parseTelegramExport(channel([], { id: undefined, name: '  Vector   Space ' }));
    expect(parsed.publicationKey).toBe('name:vector space');
  });

  it('flattens rich text to the text a reader sees, links included', () => {
    const parsed = parseTelegramExport(
      channel([
        message({
          text: [
            'Read ',
            { type: 'bold', text: 'this' },
            ' at ',
            { type: 'link', text: 'https://esa.int/x' },
            ' or ',
            { type: 'text_link', text: 'here', href: 'https://nasa.gov/y' },
            ', via ',
            { type: 'mention', text: '@esa' },
          ],
        }),
      ]),
    );

    const [item] = parsed.items;
    expect(item!.text).toBe('Read this at https://esa.int/x or here, via @esa');
    // A hidden link's target is not in the visible text, so it is kept aside.
    expect(item!.metadata).toMatchObject({ links: ['https://nasa.gov/y'] });
  });

  it('reads the spec-style plain parts too, and trims', () => {
    expect(plainText([{ type: 'plain', text: '  hello ' }, { type: 'bold', text: 'world  ' }]).text).toBe(
      'hello world',
    );
    expect(plainText('').text).toBeNull();
    expect(plainText(undefined).text).toBeNull();
  });

  it('keeps a photo with no caption', () => {
    const parsed = parseTelegramExport(
      channel([
        message({
          photo: 'photos/photo_1@18-03-2026_14-00-00.jpg',
          photo_file_size: 123456,
          width: 1280,
          height: 720,
        }),
      ]),
    );

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]!.text).toBeNull();
    expect(parsed.items[0]!.media).toEqual([
      {
        type: 'photo',
        relativePath: 'photos/photo_1@18-03-2026_14-00-00.jpg',
        available: true,
        width: 1280,
        height: 720,
        fileSizeBytes: 123456,
      },
    ]);
  });

  it('keeps a video with no caption', () => {
    const parsed = parseTelegramExport(
      channel([
        message({
          file: 'video_files/launch.mp4',
          file_name: 'launch.mp4',
          file_size: 9_000_000,
          thumbnail: 'video_files/launch.mp4_thumb.jpg',
          media_type: 'video_file',
          mime_type: 'video/mp4',
          duration_seconds: 42,
          width: 1920,
          height: 1080,
        }),
      ]),
    );

    expect(parsed.items[0]!.media).toEqual([
      {
        type: 'video',
        relativePath: 'video_files/launch.mp4',
        available: true,
        mimeType: 'video/mp4',
        width: 1920,
        height: 1080,
        durationSeconds: 42,
        fileSizeBytes: 9_000_000,
      },
    ]);
  });

  it('maps the other media types', () => {
    const typeOf = (fields: Record<string, unknown>) =>
      parseTelegramExport(channel([message({ file: 'files/x', ...fields })])).items[0]!.media[0]!.type;

    expect(typeOf({ media_type: 'animation' })).toBe('animation');
    expect(typeOf({ media_type: 'audio_file' })).toBe('audio');
    expect(typeOf({ media_type: 'voice_message' })).toBe('audio');
    expect(typeOf({ media_type: 'video_message' })).toBe('video');
    expect(typeOf({ media_type: 'sticker', sticker_emoji: '🚀' })).toBe('sticker');
    expect(typeOf({ mime_type: 'application/pdf' })).toBe('document');
    expect(typeOf({ media_type: 'something_new' })).toBe('other');
  });

  it('records a file the export left out as unavailable, not as a path', () => {
    const parsed = parseTelegramExport(
      channel([
        message({ id: 1, photo: '(File not included. Change data exporting settings to download.)' }),
        message({
          id: 2,
          file: '(File exceeds maximum size. Change data exporting settings to download.)',
          media_type: 'video_file',
        }),
        message({ id: 3, photo: '(Photo not included)' }),
      ]),
    );

    expect(parsed.items).toHaveLength(3);
    for (const item of parsed.items) {
      expect(item.media[0]).toMatchObject({ relativePath: null, available: false });
    }
    expect(parsed.items[1]!.media[0]!.type).toBe('video');
  });

  it('skips service events, unsupported and empty messages, and says why', () => {
    const parsed = parseTelegramExport(
      channel([
        { id: 1, type: 'service', date_unixtime: '1773842400', actor: 'VECTOR', action: 'create_channel', text: '' },
        { id: 2, type: 'service', date_unixtime: '1773842400', action: 'pin_message', message_id: 5, text: '' },
        { id: 3, type: 'service', date_unixtime: '1773842400', action: 'some_future_action', text: '' },
        { id: 4, type: 'unsupported' },
        message({ id: 5, text: '' }),
        message({ id: 6, text: '', poll: { question: 'Mars?', answers: [] } }),
        message({ id: 7, text: 'Kept' }),
      ]),
    );

    expect(parsed.itemsSeen).toBe(7);
    expect(parsed.items.map((item) => item.externalId)).toEqual(['7']);
    expect(parsed.skipped.map((issue) => issue.reason)).toEqual([
      'service:create_channel',
      'service:pin_message',
      'service:some_future_action',
      'type:unsupported',
      'no_text_or_media:empty',
      'no_text_or_media:poll',
    ]);
    expect(parsed.failed).toEqual([]);
  });

  it('prefers date_unixtime, and reads edits', () => {
    const parsed = parseTelegramExport(
      channel([
        message({
          // A local time that disagrees with unixtime: unixtime wins.
          date: '2026-03-18T17:00:00',
          date_unixtime: '1773842400',
          edited: '2026-03-18T17:30:00',
          edited_unixtime: '1773844200',
          text: 'x',
        }),
      ]),
    );

    expect(parsed.items[0]!.publishedAt.toISOString()).toBe('2026-03-18T14:00:00.000Z');
    expect(parsed.items[0]!.editedAt!.toISOString()).toBe('2026-03-18T14:30:00.000Z');
    expect(parsed.warnings).toEqual([]);
  });

  it('falls back to the zone-less date as UTC, with a warning', () => {
    const parsed = parseTelegramExport(
      channel([message({ id: 9, date: '2026-03-18T14:00:00', date_unixtime: undefined, text: 'x' })]),
    );

    expect(parsed.items[0]!.publishedAt.toISOString()).toBe('2026-03-18T14:00:00.000Z');
    expect(parsed.warnings).toEqual([{ externalId: '9', reason: 'date_without_timezone_read_as_utc' }]);
  });

  it('fails a message it cannot date or identify, and imports the rest', () => {
    const parsed = parseTelegramExport(
      channel([
        message({ id: 1, date: 'yesterday', date_unixtime: 'soon', text: 'x' }),
        message({ id: undefined, text: 'x' }),
        'not a message',
        message({ id: 4, text: 'fine' }),
      ]),
    );

    expect(parsed.items.map((item) => item.externalId)).toEqual(['4']);
    expect(parsed.failed).toEqual([
      { externalId: '1', reason: 'invalid_date' },
      { externalId: null, reason: 'missing_id' },
      { externalId: null, reason: 'not_an_object' },
    ]);
  });

  it('keeps reaction counts, not who reacted', () => {
    const parsed = parseTelegramExport(
      channel([
        message({
          text: 'x',
          reactions: [
            { type: 'emoji', count: 12, emoji: '🔥', recent: [{ from: 'Someone', from_id: 'user1', date: '…' }] },
            { type: 'custom_emoji', count: 3, document_id: '5368324170671202286' },
            { type: 'paid', count: 1 },
          ],
        }),
      ]),
    );

    expect(parsed.items[0]!.metrics).toEqual({
      reactions: [
        { type: 'emoji', emoji: '🔥', count: 12 },
        { type: 'custom_emoji', documentId: '5368324170671202286', count: 3 },
        { type: 'paid', count: 1 },
      ],
      reactionsTotal: 16,
    });
  });

  it('keeps provenance, not the raw message', () => {
    const parsed = parseTelegramExport(
      channel([
        message({
          text: 'x',
          author: 'Editor',
          forwarded_from: 'ESA',
          forwarded_from_id: 'channel42',
          reply_to_message_id: 7,
          inline_bot_buttons: [[{ type: 'url', text: 'Open', data: 'https://x' }]],
          text_entities: [{ type: 'plain', text: 'x' }],
        }),
      ]),
    );

    expect(parsed.items[0]!.metadata).toEqual({
      from: 'VECTOR',
      fromId: 'channel1234567890',
      author: 'Editor',
      forwardedFrom: 'ESA',
      forwardedFromId: 'channel42',
      replyToMessageId: 7,
    });
  });

  it('reads an article-format post: its text, links and photos', () => {
    const plain = (text: string) => ({ type: 'plain', text });
    const parsed = parseTelegramExport(
      channel([
        message({
          id: 184,
          text: undefined,
          text_entities: undefined,
          rich_message: {
            rtl: false,
            part: false,
            blocks: [
              {
                type: 'heading',
                level: 3,
                text: { type: 'bold', text: { type: 'concat', text: [plain('Bacteria for Mars'), plain('🦠')] } },
              },
              { type: 'paragraph', text: { type: 'empty' } },
              {
                type: 'photo',
                photo_id: '5321506192926383837',
                photo: 'photos/photo_131@27-09-2026_18-59-58.jpg',
                photo_file_size: 319173,
                width: 1695,
                height: 928,
                spoiler: false,
                caption: { text: plain('A bioreactor'), credit: { type: 'empty' } },
              },
              {
                type: 'paragraph',
                text: {
                  type: 'concat',
                  text: [
                    { type: 'bold', text: plain('Pioneer Labs') },
                    plain(' presented '),
                    { type: 'custom_emoji', text: '🌖', document_id: 'stickers/AnimatedSticker (2).tgs' },
                    plain(' sPL.001. '),
                    { type: 'text_link', href: 'https://blog.pioneer-labs.org/p/x', text: plain('Source') },
                  ],
                },
              },
              { type: 'list', kind: 'unordered', items: [{ text: plain('one') }, { blocks: [{ type: 'paragraph', text: plain('two') }] }] },
              { type: 'video', document_id: '1', file_skip_reason: 'file_size', media_type: 'video_file', duration_seconds: 90 },
              { type: 'some_future_block', text: plain('still read') },
            ],
          },
        }),
      ]),
    );

    expect(parsed.skipped).toEqual([]);
    const [item] = parsed.items;
    expect(item!.text).toBe(
      'Bacteria for Mars🦠\n\nA bioreactor\n\nPioneer Labs presented 🌖 sPL.001. Source\n\none\n\ntwo\n\nstill read',
    );
    expect(item!.media).toEqual([
      {
        type: 'photo',
        relativePath: 'photos/photo_131@27-09-2026_18-59-58.jpg',
        available: true,
        width: 1695,
        height: 928,
        fileSizeBytes: 319173,
      },
      {
        type: 'video',
        relativePath: null,
        available: false,
        mimeType: null,
        width: null,
        height: null,
        durationSeconds: 90,
        fileSizeBytes: null,
      },
    ]);
    expect(item!.metadata).toMatchObject({ links: ['https://blog.pioneer-labs.org/p/x'], format: 'rich_message' });
  });

  it('ignores fields it does not know', () => {
    const parsed = parseTelegramExport(
      channel([message({ id: 3, text: 'x', some_new_field: { deep: [1, 2] }, media_spoiler: true })], {
        some_new_top_level: true,
      }),
    );
    expect(parsed.items.map((item) => item.externalId)).toEqual(['3']);
  });

  it('rejects malformed JSON, and files that are not a chat export', async () => {
    await expect(telegramJsonAdapter.parse(fileOf('{"messages": ['))).rejects.toThrow(HistoryFormatError);
    await expect(telegramJsonAdapter.parse(fileOf('{"hello": 1}'))).rejects.toThrow(/Not a Telegram Desktop chat export/);
    await expect(telegramJsonAdapter.parse(fileOf('{"chats": {"list": []}}'))).rejects.toThrow(/whole-account export/);
  });

  it('reads a file with a byte-order mark', async () => {
    const parsed = await telegramJsonAdapter.parse(fileOf(`﻿${JSON.stringify(channel([message({ text: 'x' })]))}`));
    expect(parsed.items).toHaveLength(1);
  });
});
