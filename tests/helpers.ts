import { ne } from 'drizzle-orm';
import { resetEnvCache, type Env, getEnv } from '@/lib/env';
import type { Database } from '@/lib/db';
import { DEFAULT_WORKSPACE_ID, workspaces } from '@/db/schema';
import type { TelegramDestination } from '@/lib/workspace';
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

/**
 * Make sure the default workspace exists.
 *
 * Posts and sources carry a foreign key to it, so any test that writes them
 * directly needs the row. It is never deleted between tests — doing so would
 * cascade away everything else.
 */
export async function ensureTestWorkspace(db: Database): Promise<void> {
  // Reset, not just create: the row is never deleted between tests (posts and
  // sources reference it), so any state written on it — the legacy-import
  // marker above all — would leak into the next test and silently change what
  // the code under test decides to do. Extra workspaces a test created go too,
  // taking their sources and cursors with them via ON DELETE CASCADE.
  await db.delete(workspaces).where(ne(workspaces.id, DEFAULT_WORKSPACE_ID));
  await db
    .insert(workspaces)
    .values({ id: DEFAULT_WORKSPACE_ID, name: 'default' })
    .onConflictDoUpdate({
      target: workspaces.id,
      set: {
        name: 'default',
        legacySourceImportedAt: null,
        telegramChatId: null,
        telegramAdminChatId: null,
      },
    });
}

/** No-op sleep so retry tests run instantly. */
export const instantSleep = async () => {};

/**
 * The destination a single-tenant install produces: workspace 1, pointed at
 * whatever the environment says. Keeps unit tests on the env-derived values
 * they were written against while the production path reads the workspace row.
 */
export function testDestination(
  env: Env,
  overrides: Partial<TelegramDestination> = {},
): TelegramDestination {
  return {
    workspaceId: DEFAULT_WORKSPACE_ID,
    chatId: env.TELEGRAM_CHAT_ID,
    adminChatId: env.TELEGRAM_ADMIN_CHAT_ID ?? null,
    disableNotification: env.TELEGRAM_DISABLE_NOTIFICATION,
    ...overrides,
  };
}
