import { z } from 'zod';
import type { TelegramClient } from '@/lib/telegram/client';
import { telegramMessageSchema, type TelegramMessage } from '@/lib/telegram/client';
import { TELEGRAM_PARSE_MODE } from '@/lib/telegram/format-caption';
import type { DownloadedMedia } from '@/lib/x/download-media';
import type { NormalizedMedia } from '@/types';

/**
 * The four Bot API send methods this application uses.
 *
 * Each accepts either a downloaded buffer (multipart upload) or a plain URL,
 * matching MEDIA_UPLOAD_MODE. Multipart is the default because it has the
 * higher size ceiling (10 MB photo / 50 MB video vs 5 / 20 by URL) and does not
 * depend on Telegram's servers being able to reach the X CDN.
 */

export interface SendContext {
  client: TelegramClient;
  chatId: string;
  disableNotification: boolean;
}

export type MediaPayload =
  | { mode: 'multipart'; downloaded: DownloadedMedia }
  | { mode: 'url'; media: NormalizedMedia };

function payloadMedia(payload: MediaPayload): NormalizedMedia {
  return payload.mode === 'multipart' ? payload.downloaded.media : payload.media;
}

function toBlob(downloaded: DownloadedMedia): Blob {
  // Copy into a fresh ArrayBuffer so the Blob never aliases a pooled buffer.
  const buffer = new ArrayBuffer(downloaded.bytes.byteLength);
  new Uint8Array(buffer).set(downloaded.bytes);
  return new Blob([buffer], { type: downloaded.contentType });
}

export async function sendPhoto(
  context: SendContext,
  payload: MediaPayload,
  caption: string,
): Promise<TelegramMessage> {
  if (payload.mode === 'url') {
    return context.client.call(
      'sendPhoto',
      {
        chat_id: context.chatId,
        photo: payloadMedia(payload).url,
        ...(caption ? { caption, parse_mode: TELEGRAM_PARSE_MODE } : {}),
        disable_notification: context.disableNotification,
      },
      telegramMessageSchema,
    );
  }

  const form = new FormData();
  form.set('chat_id', context.chatId);
  form.set('photo', toBlob(payload.downloaded), payload.downloaded.filename);
  if (caption) {
    form.set('caption', caption);
    form.set('parse_mode', TELEGRAM_PARSE_MODE);
  }
  form.set('disable_notification', String(context.disableNotification));

  return context.client.call('sendPhoto', form, telegramMessageSchema);
}

export async function sendVideo(
  context: SendContext,
  payload: MediaPayload,
  caption: string,
): Promise<TelegramMessage> {
  const media = payloadMedia(payload);

  // Telegram can render a progress bar and allow seeking before the download
  // completes when it knows the video is streamable and how big the frame is.
  const metadata: Record<string, unknown> = { supports_streaming: true };
  if (media.width) metadata.width = media.width;
  if (media.height) metadata.height = media.height;
  if (media.durationSeconds) metadata.duration = media.durationSeconds;

  if (payload.mode === 'url') {
    return context.client.call(
      'sendVideo',
      {
        chat_id: context.chatId,
        video: media.url,
        ...(caption ? { caption, parse_mode: TELEGRAM_PARSE_MODE } : {}),
        ...metadata,
        disable_notification: context.disableNotification,
      },
      telegramMessageSchema,
    );
  }

  const form = new FormData();
  form.set('chat_id', context.chatId);
  form.set('video', toBlob(payload.downloaded), payload.downloaded.filename);
  if (caption) {
    form.set('caption', caption);
    form.set('parse_mode', TELEGRAM_PARSE_MODE);
  }
  for (const [key, value] of Object.entries(metadata)) form.set(key, String(value));
  form.set('disable_notification', String(context.disableNotification));

  return context.client.call('sendVideo', form, telegramMessageSchema);
}

/**
 * Send 2–10 items as a single album.
 *
 * Photos and videos may be mixed freely — the Bot API only forbids mixing
 * documents and audio with other types. The caption is attached to the first
 * item only, which is how Telegram renders an album caption.
 *
 * Multipart uploads use the `attach://<name>` indirection: the JSON `media`
 * array references form fields carrying the actual bytes.
 */
export async function sendMediaGroup(
  context: SendContext,
  payloads: MediaPayload[],
  caption: string,
): Promise<TelegramMessage[]> {
  const form = new FormData();
  const descriptors: Record<string, unknown>[] = [];
  let usesMultipart = false;

  payloads.forEach((payload, index) => {
    const media = payloadMedia(payload);
    const descriptor: Record<string, unknown> = { type: media.kind };

    if (payload.mode === 'multipart') {
      usesMultipart = true;
      const attachName = `file_${index}`;
      form.set(attachName, toBlob(payload.downloaded), payload.downloaded.filename);
      descriptor.media = `attach://${attachName}`;
    } else {
      descriptor.media = media.url;
    }

    if (media.kind === 'video') {
      descriptor.supports_streaming = true;
      if (media.width) descriptor.width = media.width;
      if (media.height) descriptor.height = media.height;
      if (media.durationSeconds) descriptor.duration = media.durationSeconds;
    }

    // Only the first item carries the caption; Telegram shows it for the album.
    if (index === 0 && caption) {
      descriptor.caption = caption;
      descriptor.parse_mode = TELEGRAM_PARSE_MODE;
    }

    descriptors.push(descriptor);
  });

  const resultSchema = z.array(telegramMessageSchema);

  if (!usesMultipart) {
    return context.client.call(
      'sendMediaGroup',
      {
        chat_id: context.chatId,
        media: descriptors,
        disable_notification: context.disableNotification,
      },
      resultSchema,
    );
  }

  form.set('chat_id', context.chatId);
  form.set('media', JSON.stringify(descriptors));
  form.set('disable_notification', String(context.disableNotification));

  return context.client.call('sendMediaGroup', form, resultSchema);
}

export async function sendText(
  context: SendContext,
  text: string,
  options?: { replyToMessageId?: number },
): Promise<TelegramMessage> {
  return context.client.call(
    'sendMessage',
    {
      chat_id: context.chatId,
      text,
      parse_mode: TELEGRAM_PARSE_MODE,
      // The media already shows the preview; a second link card would be noise.
      link_preview_options: { is_disabled: true },
      disable_notification: context.disableNotification,
      ...(options?.replyToMessageId
        ? { reply_parameters: { message_id: options.replyToMessageId, allow_sending_without_reply: true } }
        : {}),
    },
    telegramMessageSchema,
  );
}
