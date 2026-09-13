import { z } from 'zod';
import { getEnv } from '@/lib/env';
import { TelegramApiError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { withRetry } from '@/lib/sync/retry';

/**
 * Telegram Bot API transport.
 *
 * Everything the publisher does goes through `call()`, which centralises the
 * two things that are easy to get wrong:
 *   - classifying failures as transient vs permanent;
 *   - honouring `parameters.retry_after` on 429 instead of hammering the API.
 */

export const telegramMessageSchema = z.object({
  message_id: z.number(),
  chat: z.object({ id: z.number(), title: z.string().optional(), username: z.string().optional() }),
  date: z.number().optional(),
});

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
}
