import { resetEnvCache, type Env, getEnv } from '@/lib/env';
import { createLogger, type Logger } from '@/lib/logger';

/** Run `fn` with temporary environment overrides, then restore. */
export async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: (env: Env) => Promise<T> | T,
): Promise<T> {
  const previous: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  resetEnvCache();

  try {
    return await fn(getEnv());
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvCache();
  }
}

/** Logger that records entries instead of writing to stdout. */
export function createTestLogger(): Logger & { entries: { event: string; data?: unknown }[] } {
  const entries: { event: string; data?: unknown }[] = [];

  const make = (): Logger => ({
    debug: (event, data) => entries.push({ event, data }),
    info: (event, data) => entries.push({ event, data }),
    warn: (event, data) => entries.push({ event, data }),
    error: (event, data) => entries.push({ event, data }),
    child: () => make(),
  });

  return Object.assign(make(), { entries });
}

export const silentLogger = createLogger({});

/** Telegram-shaped JSON response. */
export function telegramOk(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

export function telegramError(
  errorCode: number,
  description: string,
  parameters?: Record<string, unknown>,
): Response {
  return new Response(
    JSON.stringify({ ok: false, error_code: errorCode, description, ...(parameters ? { parameters } : {}) }),
    { status: errorCode, headers: { 'content-type': 'application/json' } },
  );
}

/** No-op sleep so retry tests run instantly. */
export const instantSleep = async () => {};
