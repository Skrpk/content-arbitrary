import { z } from 'zod';
import { getEnv } from '@/lib/env';
import { TelegramApiError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import type { InlineKeyboardMarkup } from '@/lib/telegram/send-media';
import { withRetry } from '@/lib/sync/retry';

/**
 * Telegram Bot API transport.
 *
 * Everything the publisher does goes through `call()`, which centralises the
 * two things that are easy to get wrong:
 *   - classifying failures as transient vs permanent;
 *   - honouring `parameters.retry_after` on 429 instead of hammering the API.
 */

/** PhotoSize entries are ordered smallest → largest; we want the last. */
const photoSizeSchema = z.object({
  file_id: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  file_size: z.number().optional(),
});

const videoSchema = z.object({
  file_id: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  duration: z.number().optional(),
  file_size: z.number().optional(),
});

export const telegramMessageSchema = z.object({
  message_id: z.number(),
  chat: z.object({ id: z.number(), title: z.string().optional(), username: z.string().optional() }),
  date: z.number().optional(),
  /**
   * Present on messages that carry media. Telegram stores the uploaded file and
   * hands back a `file_id`, which can be re-sent to any other chat without
   * uploading the bytes again — this is what makes approval cheap.
   */
  photo: z.array(photoSizeSchema).optional(),
  video: videoSchema.optional(),
});

/** The largest rendition Telegram kept, which is the one to re-send. */
export function largestPhotoFileId(message: TelegramMessage): string | undefined {
  if (!message.photo || message.photo.length === 0) return undefined;
  return message.photo.reduce((largest, size) =>
    (size.file_size ?? 0) >= (largest.file_size ?? 0) ? size : largest,
  ).file_id;
}

/** file_id of whatever media a sent message carries, photo or video. */
export function mediaFileIdOf(message: TelegramMessage): string | undefined {
  return message.video?.file_id ?? largestPhotoFileId(message);
}

export type TelegramMessage = z.infer<typeof telegramMessageSchema>;

const responseParametersSchema = z.object({
  retry_after: z.number().optional(),
  migrate_to_chat_id: z.number().optional(),
});

const apiResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
  error_code: z.number().optional(),
  parameters: responseParametersSchema.optional(),
});

export const getMeResultSchema = z.object({
  id: z.number(),
  is_bot: z.boolean(),
  username: z.string().optional(),
  first_name: z.string().optional(),
  can_read_all_group_messages: z.boolean().optional(),
});

export const chatMemberSchema = z.object({
  status: z.string(),
  can_post_messages: z.boolean().optional(),
  user: z.object({ id: z.number(), username: z.string().optional() }).optional(),
});

export const chatSchema = z.object({
  id: z.number(),
  type: z.string(),
  title: z.string().optional(),
  username: z.string().optional(),
});

/**
 * Descriptions that mean "this will never work", so the caller can record the
 * reason and stop rather than burning all five retries.
 */
const PERMANENT_DESCRIPTION_PATTERNS: RegExp[] = [
  /chat not found/i,
  /bot was kicked/i,
  /bot is not a member/i,
  /not enough rights/i,
  /have no rights to send/i,
  /CHAT_WRITE_FORBIDDEN/i,
  /user is deactivated/i,
  /PHOTO_INVALID_DIMENSIONS/i,
  /PHOTO_SAVE_FILE_INVALID/i,
  /IMAGE_PROCESS_FAILED/i,
  /wrong file identifier/i,
  /failed to get HTTP URL content/i,
  /wrong type of the web page content/i,
  /file is too big/i,
  /VIDEO_FILE_INVALID/i,
  /unsupported (?:file|media)/i,
  /message caption is too long/i,
  /message is too long/i,
  /can't parse entities/i,
];

function isPermanentDescription(description: string | undefined): boolean {
  if (!description) return false;
  return PERMANENT_DESCRIPTION_PATTERNS.some((pattern) => pattern.test(description));
}

export class TelegramClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly logger?: Logger;
  private readonly attempts: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep?: (ms: number) => Promise<void>;

  constructor(options?: {
    token?: string;
    baseUrl?: string;
    logger?: Logger;
    attempts?: number;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  }) {
    const env = options?.token && options?.baseUrl ? null : getEnv();
    this.token = options?.token ?? env!.TELEGRAM_BOT_TOKEN;
    this.baseUrl = (options?.baseUrl ?? env!.TELEGRAM_API_BASE_URL).replace(/\/+$/, '');
    this.logger = options?.logger;
    this.attempts = options?.attempts ?? env?.MAX_RETRY_ATTEMPTS ?? 5;
    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.sleep = options?.sleep;
  }

  private endpoint(method: string): string {
    return `${this.baseUrl}/bot${this.token}/${method}`;
  }

  /**
   * Invoke a Bot API method with retries.
   *
   * `body` may be a FormData (multipart upload) or a plain object (JSON).
   */
  async call<T>(method: string, body: FormData | Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    return withRetry(
      async () => {
        const isMultipart = body instanceof FormData;

        const response = await this.fetchImpl(this.endpoint(method), {
          method: 'POST',
          headers: isMultipart ? undefined : { 'content-type': 'application/json' },
          body: isMultipart ? body : JSON.stringify(body),
          cache: 'no-store',
        });

        const rawText = await response.text();
        let raw: unknown;
        try {
          raw = JSON.parse(rawText);
        } catch {
          throw new TelegramApiError(
            `Telegram returned non-JSON response (HTTP ${response.status})`,
            { transient: response.status >= 500, code: 'telegram_bad_response', status: response.status },
          );
        }

        const parsed = apiResponseSchema.safeParse(raw);
        if (!parsed.success) {
          throw new TelegramApiError(`Unexpected Telegram response shape: ${parsed.error.message}`, {
            transient: false,
            code: 'telegram_schema_mismatch',
            status: response.status,
          });
        }

        const payload = parsed.data;

        if (!payload.ok) {
          const description = payload.description ?? 'unknown error';

          // Flood control: Telegram tells us exactly how long to wait. Obey it.
          if (payload.error_code === 429 || response.status === 429) {
            const retryAfterSeconds = payload.parameters?.retry_after ?? 1;
            this.logger?.warn('telegram.rate_limited', {
              method,
              retryAfterSeconds,
              description,
            });
            throw new TelegramApiError(`Telegram rate limited: ${description}`, {
              transient: true,
              code: 'telegram_rate_limited',
              status: 429,
              description,
              retryAfterMs: retryAfterSeconds * 1000,
            });
          }

          if (isPermanentDescription(description)) {
            throw new TelegramApiError(`Telegram rejected ${method}: ${description}`, {
              transient: false,
              code: 'telegram_permanent',
              status: response.status,
              description,
            });
          }

          // 5xx and anything unrecognised: assume it may recover.
          const transient = (payload.error_code ?? response.status) >= 500;
          throw new TelegramApiError(`Telegram ${method} failed: ${description}`, {
            transient,
            code: transient ? 'telegram_server_error' : 'telegram_error',
            status: payload.error_code ?? response.status,
            description,
          });
        }

        const result = schema.safeParse(payload.result);
        if (!result.success) {
          throw new TelegramApiError(
            `Unexpected Telegram result for ${method}: ${result.error.message}`,
            { transient: false, code: 'telegram_result_mismatch' },
          );
        }

        return result.data;
      },
      {
        attempts: this.attempts,
        logger: this.logger,
        label: `telegram:${method}`,
        sleep: this.sleep,
        // A flood wait longer than this means we should stop and let the next
        // cron run pick the work up, rather than hold the function open.
        maxRetryAfterMs: 120_000,
      },
    );
  }

  getMe() {
    return this.call('getMe', {}, getMeResultSchema);
  }

  getChat(chatId: string) {
    return this.call('getChat', { chat_id: chatId }, chatSchema);
  }

  getChatMember(chatId: string, userId: number) {
    return this.call('getChatMember', { chat_id: chatId, user_id: userId }, chatMemberSchema);
  }

  /**
   * Dismisses the spinner on the pressed button. Telegram requires this for
   * every callback query; without it the client shows a loading state for
   * about a minute.
   */
  answerCallbackQuery(callbackQueryId: string, text?: string) {
    return this.call(
      'answerCallbackQuery',
      { callback_query_id: callbackQueryId, ...(text ? { text } : {}) },
      z.boolean(),
    );
  }

  /**
   * Replaces a message's buttons — by default with none, which strips them off
   * a reviewed message so it cannot be actioned twice.
   */
  editMessageReplyMarkup(
    chatId: string,
    messageId: number,
    replyMarkup: InlineKeyboardMarkup = { inline_keyboard: [] },
  ) {
    return this.call(
      'editMessageReplyMarkup',
      { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup },
      z.union([telegramMessageSchema, z.boolean()]),
    );
  }

  /** Replaces a message's text and, by default, strips its buttons. */
  editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    parseMode: string,
    replyMarkup: InlineKeyboardMarkup = { inline_keyboard: [] },
  ) {
    return this.call(
      'editMessageText',
      {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: parseMode,
        link_preview_options: { is_disabled: true },
        reply_markup: replyMarkup,
      },
      z.union([telegramMessageSchema, z.boolean()]),
    );
  }

  editMessageCaption(chatId: string, messageId: number, caption: string, parseMode: string) {
    return this.call(
      'editMessageCaption',
      {
        chat_id: chatId,
        message_id: messageId,
        caption,
        parse_mode: parseMode,
        reply_markup: { inline_keyboard: [] },
      },
      z.union([telegramMessageSchema, z.boolean()]),
    );
  }

  setWebhook(url: string, secretToken: string) {
    return this.call(
      'setWebhook',
      {
        url,
        secret_token: secretToken,
        // Button presses, plus the slash commands that manage the source list.
        allowed_updates: ['callback_query', 'message'],
        drop_pending_updates: true,
      },
      z.boolean(),
    );
  }

  deleteWebhook() {
    return this.call('deleteWebhook', { drop_pending_updates: true }, z.boolean());
  }

  /**
   * Fetch the bytes of a file Telegram stores, by file_id. Telegram serves bots
   * files of up to 20 MB this way.
   *
   * The download URL carries the bot token, so it is never logged or put in
   * an error message.
   */
  async downloadFile(fileId: string): Promise<{ bytes: Uint8Array; filePath: string }> {
    const file = await this.call(
      'getFile',
      { file_id: fileId },
      z.object({ file_path: z.string().optional() }),
    );
    if (!file.file_path) {
      throw new TelegramApiError('Telegram returned no file_path for the file', {
        transient: false,
        code: 'telegram_no_file_path',
      });
    }

    const response = await this.fetchImpl(`${this.baseUrl}/file/bot${this.token}/${file.file_path}`, {
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new TelegramApiError(`Telegram file download failed (HTTP ${response.status})`, {
        transient: response.status >= 500,
        code: 'telegram_file_download_failed',
        status: response.status,
      });
    }

    return { bytes: new Uint8Array(await response.arrayBuffer()), filePath: file.file_path };
  }

  getWebhookInfo() {
    return this.call(
      'getWebhookInfo',
      {},
      z.object({
        url: z.string(),
        pending_update_count: z.number().optional(),
        last_error_message: z.string().optional(),
        last_error_date: z.number().optional(),
      }),
    );
  }
}
