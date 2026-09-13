import { z } from 'zod';

/**
 * Runtime configuration.
 *
 * Everything is validated once, at first access, with Zod. A misconfigured
 * deployment therefore fails loudly on the first request instead of silently
 * misbehaving halfway through a publish.
 *
 * NOTE: never log the parsed object directly — it contains secrets.
 * Use `redactedEnvSummary()` when you need to surface configuration state.
 */

const booleanish = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    });

const optionalText = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? '' : value));

const intInRange = (min: number, max: number, defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === '') return defaultValue;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        ctx.addIssue({
          code: 'custom',
          message: `must be an integer between ${min} and ${max}, received "${value}"`,
        });
        return z.NEVER;
      }
      return parsed;
    });

/**
 * A closed set of allowed values that, like every other optional variable here,
 * treats an empty string as "not set".
 *
 * Vercel supplies an environment variable added without a value as `''`, not as
 * `undefined`, so a bare `z.enum([...]).optional()` rejects it. Matching is
 * case-insensitive and the error repeats what was actually received, which is
 * what makes a misconfiguration obvious from the message alone.
 */
const enumWithDefault = <T extends readonly [string, ...string[]]>(
  allowed: T,
  defaultValue: T[number],
) =>
  z
    .string()
    .optional()
    .transform((value, ctx): T[number] => {
      if (value === undefined || value.trim() === '') return defaultValue;

      const normalised = value.trim().toLowerCase();
      if (!allowed.includes(normalised)) {
        ctx.addIssue({
          code: 'custom',
          message: `must be one of ${allowed.map((option) => `"${option}"`).join(' | ')}, received "${value}"`,
        });
        return z.NEVER;
      }

      return normalised;
    });

/**
 * Telegram accepts either a numeric chat id (`-1001234567890`) or a public
 * channel username (`@channelusername`). Private channels have no username, so
 * the numeric form is the only universally correct option — we accept both and
 * say so in the error message.
 */
const telegramChatId = z
  .string()
  .min(1, 'TELEGRAM_CHAT_ID is required')
  .refine(
    (value) => /^-?\d+$/.test(value) || /^@[A-Za-z0-9_]{5,}$/.test(value),
    'TELEGRAM_CHAT_ID must be a numeric id (e.g. -1001234567890) or a public @channelusername',
  );

const schema = z
  .object({
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required')
      .refine(
        (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
        'DATABASE_URL must be a postgres:// or postgresql:// connection string',
      ),

    X_USER_ID: z
      .string()
      .regex(/^\d{1,19}$/, 'X_USER_ID must be a numeric X user id')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    X_USERNAME: z
      .string()
      .regex(/^@?[A-Za-z0-9_]{1,15}$/, 'X_USERNAME must be a valid X handle')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    X_BEARER_TOKEN: z.string().min(1, 'X_BEARER_TOKEN is required'),
    X_API_BASE_URL: z
      .string()
      .optional()
      .transform((value) => (value && value.trim() !== '' ? value.trim() : 'https://api.x.com')),

    TELEGRAM_BOT_TOKEN: z
      .string()
      .regex(/^\d+:[A-Za-z0-9_-]+$/, 'TELEGRAM_BOT_TOKEN must look like 123456:ABC-DEF...'),
    TELEGRAM_CHAT_ID: telegramChatId,
    TELEGRAM_API_BASE_URL: z
      .string()
      .optional()
      .transform((value) => (value && value.trim() !== '' ? value.trim() : 'https://api.telegram.org')),
    TELEGRAM_DISABLE_NOTIFICATION: booleanish(false),

    CRON_SECRET: z.string().min(16, 'CRON_SECRET must be at least 16 characters'),
    ADMIN_SECRET: z.string().min(16).optional().or(z.literal('').transform(() => undefined)),

    CAPTION_PREFIX: optionalText,
    CAPTION_SUFFIX: optionalText,
    INCLUDE_SOURCE_LINK: booleanish(true),

    INCLUDE_REPLIES: booleanish(false),
    INCLUDE_REPOSTS: booleanish(false),
    INCLUDE_QUOTES: booleanish(true),

    MAX_POSTS_PER_RUN: intInRange(1, 100, 5),
    /**
     * How many posts to ask X for. The API requires 5..100. We keep this
     * separate from MAX_POSTS_PER_RUN because we must fetch enough posts to
     * find media posts among replies/retweets we discard client-side.
     */
    X_FETCH_LIMIT: intInRange(5, 100, 20),
    MAX_RETRY_ATTEMPTS: intInRange(1, 10, 5),

    DRY_RUN: booleanish(true),

    /**
     * `multipart` downloads the asset and uploads the bytes (most reliable,
     * highest Telegram size ceiling). `url` hands Telegram the CDN link
     * (cheapest, but lower size ceiling and Telegram must reach the host).
     */
    MEDIA_UPLOAD_MODE: enumWithDefault(['multipart', 'url'] as const, 'multipart'),
  })
  .superRefine((value, ctx) => {
    if (!value.X_USER_ID && !value.X_USERNAME) {
      ctx.addIssue({
        code: 'custom',
        path: ['X_USER_ID'],
        message: 'Either X_USER_ID or X_USERNAME must be set',
      });
    }
    if (value.MAX_POSTS_PER_RUN > value.X_FETCH_LIMIT) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAX_POSTS_PER_RUN'],
        message: 'MAX_POSTS_PER_RUN must not exceed X_FETCH_LIMIT',
      });
    }
  });

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  cached = parsed.data;
  return cached;
}

/** Test seam: forget the memoised config so a test can swap process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}

/**
 * Safe-to-serialise view of the configuration. Secrets are reduced to a
 * boolean "is it set" so that /api/status can report misconfiguration without
 * ever leaking a token.
 */
export function redactedEnvSummary(env: Env = getEnv()) {
  return {
    xAccount: env.X_USERNAME ?? env.X_USER_ID ?? null,
    telegramChatId: env.TELEGRAM_CHAT_ID,
    hasXBearerToken: Boolean(env.X_BEARER_TOKEN),
    hasTelegramBotToken: Boolean(env.TELEGRAM_BOT_TOKEN),
    hasAdminSecret: Boolean(env.ADMIN_SECRET),
    dryRun: env.DRY_RUN,
    includeReplies: env.INCLUDE_REPLIES,
    includeReposts: env.INCLUDE_REPOSTS,
    includeQuotes: env.INCLUDE_QUOTES,
    includeSourceLink: env.INCLUDE_SOURCE_LINK,
    maxPostsPerRun: env.MAX_POSTS_PER_RUN,
    maxRetryAttempts: env.MAX_RETRY_ATTEMPTS,
    mediaUploadMode: env.MEDIA_UPLOAD_MODE,
  } as const;
}
