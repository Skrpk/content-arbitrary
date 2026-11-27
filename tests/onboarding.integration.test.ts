import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import {
  DEFAULT_WORKSPACE_ID,
  onboardingSessions,
  publicationHistoryImports,
  publicationHistoryItems,
  publicationHistoryProfiles,
  users,
  workspaceMembers,
  workspaces,
} from '@/db/schema';
import { getEnv, type Env } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { handleOnboardingMessage, type OnboardingMessage } from '@/lib/onboarding/routing';
import { runOnboarding, runOnboardingStep, type RunnerDeps } from '@/lib/onboarding/runner';
import { ONBOARDING_MAX_ATTEMPTS } from '@/lib/onboarding/limits';
import type { RadarProvider } from '@/lib/radar/providers/types';
import { TelegramClient } from '@/lib/telegram/client';
import { setEditorialProfile } from '@/lib/workspace';
import { addWorkspaceMember } from '@/lib/accounts/users';
import { channelPage } from './channel-page-fakes';
import { notesFixture, profileFixture } from './history-fakes';
import { ensureTestWorkspace, telegramOk, withEnv } from './helpers';

/**
 * Onboarding in the bot, against a real database: /start, the channel, the
 * workspace it makes, and the steps that read the channel's history and
 * write its profile — with Telegram, t.me and the model faked.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

const ME = 424242;
const STRANGER = 777001;
const CHANNEL_ID = -1001234567890;

const envVars = {
  DATABASE_URL: connectionString,
  TELEGRAM_BOT_TOKEN: '123456:AAHfakeTokenForTestsOnly',
  APP_BASE_URL: 'https://example.vercel.app',
  ONBOARDING_ALLOWLIST: `${ME}, 111`,
};

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;
let env: Env;

beforeAll(async () => {
  if (!connectionString) return;
  sql = postgres(connectionString, { max: 4, prepare: false });
  db = drizzle(sql, { schema });
  env = await withEnv(envVars, () => getEnv());
});

afterAll(async () => {
  if (sql) await sql.end();
});

let sent: { method: string; body: Record<string, unknown> }[];
/** What getChat says, by @username. */
let chats: Record<string, { id: number; type: string; title?: string }>;
/** How many posts each channel's page has; a function to fail instead. */
let pages: Record<string, number | (() => Response)>;

beforeEach(async () => {
  if (!connectionString) return;
  sent = [];
  chats = { '@spacenews': { id: CHANNEL_ID, type: 'channel', title: 'Космос UA' }, '@somegroup': { id: -100777, type: 'supergroup', title: 'A group' } };
  pages = { spacenews: 60 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 't.me') {
        const name = url.pathname.split('/').pop()!.toLowerCase();
        const page = pages[name];
        if (typeof page === 'function') return page();
        if (page === undefined) return new Response('', { status: 302, headers: { location: 'https://telegram.org' } });
        const before = Number(url.searchParams.get('before') ?? page + 1);
        const ids = Array.from({ length: page }, (_, index) => index + 1).filter((id) => id < before).slice(-20);
        return new Response(
          channelPage(ids.map((id) => ({ id, text: `Новина ${id} про космос`, date: new Date(Date.UTC(2026, 10, 1) + id * 60_000).toISOString() })), 'Космос UA', name),
        );
      }
      const method = url.pathname.split('/').pop()!;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      sent.push({ method, body });
      if (method === 'getChat') {
        const chat = chats[String(body.chat_id)];
        return chat ? telegramOk(chat) : new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }), { status: 400 });
      }
      if (method === 'sendMessage') return telegramOk({ message_id: 500 + sent.length, chat: { id: Number(body.chat_id) } });
      return telegramOk(true);
    }),
  );
  await db.delete(onboardingSessions);
  await db.delete(publicationHistoryProfiles);
  await db.delete(publicationHistoryItems);
  await db.delete(publicationHistoryImports);
  await db.delete(users);
  await ensureTestWorkspace(db);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const logger = createLogger({ app: 'test' });
const kicked: number[] = [];

const send = (text: string, from = ME, languageCode = 'uk') =>
  handleOnboardingMessage(
    { chat: { id: from, type: 'private' }, from: { id: from, language_code: languageCode, first_name: 'Vita' }, text } satisfies OnboardingMessage,
    { db, env, client: new TelegramClient({ logger }), logger, kick: (id) => kicked.push(id) },
  );

const lastText = () => String(sent.filter((call) => call.method === 'sendMessage').at(-1)?.body.text ?? '');
const session = async () => (await db.select().from(onboardingSessions))[0]!;

/** A model that answers each of the profiler's requests, and the initial profile's. */
function fakeModel(options: { fail?: () => boolean } = {}): RadarProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: 'openai',
    model: 'fake-model',
    calls,
    async complete<T>(request: { schemaName: string; input: string }) {
      calls.push(request.schemaName);
      if (options.fail?.()) throw new Error('the model timed out');
      const usage = { inputTokens: 100, outputTokens: 50 };
      if (request.schemaName === 'history_notes') {
        const ids = [...request.input.matchAll(/<item id="(\d+)"/g)].map((match) => Number(match[1]));
        return { output: notesFixture(ids) as T, usage };
      }
      if (request.schemaName === 'publication_profile') {
        return { output: profileFixture({ coreTopics: [{ name: 'космос', strength: 'high', description: 'Новини космосу.' }], representativeItemIds: [] }) as T, usage };
      }
      return { output: { editorialProfile: 'Канал про космос: запуски, місії, відкриття.', languageCode: 'uk', topics: ['запуски ракет', 'місії до Марса'] } as T, usage };
    },
  } as unknown as RadarProvider & { calls: string[] };
}

const deps = (provider: RadarProvider | null = fakeModel()): RunnerDeps => ({
  db,
  env,
  client: new TelegramClient({ logger }),
  provider,
  embeddings: null,
  logger,
  sleep: async () => {},
});

describeIfDb('onboarding in the bot', () => {
  it('is not offered to someone the allowlist does not name', async () => {
    expect(await send('/start', STRANGER)).toBe(false);
    expect(await db.select().from(onboardingSessions)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('asks for the channel on /start, and again while it waits', async () => {
    expect(await send('/start')).toBe(true);
    expect(lastText()).toMatch(/Надішли мені публічний Telegram-канал/);
    expect(await session()).toMatchObject({ status: 'awaiting_channel', telegramUserId: String(ME), language: 'uk' });

    await send('/start');
    expect(lastText()).toMatch(/Чекаю на твій канал/);
    expect(await db.select().from(onboardingSessions)).toHaveLength(1);
  });

  it('turns away what is not a public channel with posts, and keeps waiting', async () => {
    await send('/start');
    await send('@somegroup');
    expect(lastText()).toMatch(/Не можу прочитати цей канал/);
    await send('https://t.me/+AbCdEf123');
    expect(lastText()).toMatch(/приватний канал/);
    await send('@nobody_here');
    expect(lastText()).toMatch(/Не можу прочитати/);
    chats['@empty_channel'] = { id: -100555, type: 'channel', title: 'Empty' };
    pages.empty_channel = 0;
    await send('@empty_channel');
    expect(lastText()).toMatch(/не знайшов жодного поста/);
    expect(await session()).toMatchObject({ status: 'awaiting_channel', workspaceId: null });
  });

  it('makes a self-service workspace for the channel, unconnected, with a daily digest, and starts reading it', async () => {
    await send('/start');
    kicked.length = 0;
    await send('https://t.me/spacenews');

    const open = await session();
    expect(open).toMatchObject({ status: 'analyzing_history', channelUsername: 'spacenews', channelChatId: String(CHANNEL_ID), channelTitle: 'Космос UA' });
    expect(kicked).toEqual([open.id]);
    expect(lastText()).toMatch(/Знайшов <b>Космос UA<\/b>/);

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, open.workspaceId!));
    expect(workspace).toMatchObject({
      name: 'Космос UA',
      telegramChatId: String(CHANNEL_ID),
      telegramAdminChatId: String(ME),
      createdVia: 'self_service',
      channelVerifiedAt: null,
      autoPublish: false,
      reviewDigestMinutes: 1440,
      reviewDigestHour: 9,
      reviewDigestTimezone: 'Europe/Kyiv',
    });
    expect(workspace!.reviewDigestSentAt).not.toBeNull();
    const members = await db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspace!.id));
    expect(members).toEqual([expect.objectContaining({ userId: open.userId, role: 'owner' })]);
  });

  it('reads the history, then writes the profile and language, step by step', async () => {
    await send('/start');
    await send('@spacenews');
    const { id, workspaceId } = await session();
    const model = fakeModel();

    expect(await runOnboardingStep(id, deps(model))).toBe('ran');
    expect(await session()).toMatchObject({ status: 'profiling', attempts: 0, progress: { usable: 60, inspected: 60 } });
    expect(await db.select().from(publicationHistoryItems).where(eq(publicationHistoryItems.workspaceId, workspaceId!))).toHaveLength(60);
    expect(sent.filter((call) => call.method === 'editMessageText').at(-1)?.body.text).toMatch(/прочитав останні 60 постів/);

    expect(await runOnboardingStep(id, deps(model))).toBe('ran');
    const done = await session();
    expect(done).toMatchObject({ status: 'active', progress: { topics: ['запуски ракет', 'місії до Марса'], editorialProfileWritten: true, languageWritten: 'uk' } });
    expect(done.completedAt).not.toBeNull();
    expect(model.calls).toContain('initial_editorial_profile');

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId!));
    expect(workspace).toMatchObject({ editorialProfile: 'Канал про космос: запуски, місії, відкриття.', editorialProfileSource: 'auto', language: 'uk' });
    expect(lastText()).toMatch(/Профіль каналу готовий/);
    expect(sent.filter((call) => call.method === 'editMessageText').at(-1)?.body.text).toMatch(/• запуски ракет\n• місії до Марса/);

    // Over: nothing more to run, and a new /start is no longer "waiting".
    expect(await runOnboardingStep(id, deps(model))).toBe('not_runnable');
  });

  it('runs a step once when two runners race for it', async () => {
    await send('/start');
    await send('@spacenews');
    const { id } = await session();
    const outcomes = await Promise.all([runOnboardingStep(id, deps()), runOnboardingStep(id, deps())]);
    expect(outcomes.sort()).toEqual(['not_runnable', 'ran']);
    expect(await db.select().from(publicationHistoryImports)).toHaveLength(1);
  });

  it('backs off a step that may pass, then gives up and says so', async () => {
    await send('/start');
    await send('@spacenews');
    const { id } = await session();
    pages.spacenews = () => new Response('', { status: 502 });

    expect(await runOnboardingStep(id, deps())).toBe('retrying');
    const waiting = await session();
    expect(waiting).toMatchObject({ status: 'analyzing_history', attempts: 1, lockedUntil: null });
    expect(waiting.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    // Not before its time.
    expect(await runOnboardingStep(id, deps())).toBe('not_runnable');

    for (let attempt = 2; attempt <= ONBOARDING_MAX_ATTEMPTS; attempt += 1) {
      await db.update(onboardingSessions).set({ nextAttemptAt: null }).where(eq(onboardingSessions.id, id));
      const outcome = await runOnboardingStep(id, deps());
      expect(outcome).toBe(attempt === ONBOARDING_MAX_ATTEMPTS ? 'failed' : 'retrying');
    }
    expect(await session()).toMatchObject({ status: 'failed', errorCode: 'channel_http_error' });
    expect(lastText()).toMatch(/Щось пішло не так/);
  });

  it('fails at once when no model is configured to profile the channel', async () => {
    await send('/start');
    await send('@spacenews');
    const { id } = await session();
    await runOnboardingStep(id, deps(null));
    expect(await runOnboardingStep(id, deps(null))).toBe('failed');
    expect(await session()).toMatchObject({ status: 'failed', errorCode: 'no_model' });
  });

  it('runs every due session from the cron, within its budget', async () => {
    await send('/start');
    await send('@spacenews');
    const tally = await runOnboarding(deps(), { budgetMs: 60_000, stepTimeMs: 1 });
    expect(tally).toEqual({ ran: 2, failed: 0, retrying: 0 });
    expect(await session()).toMatchObject({ status: 'active' });
  });

  it('leaves a reviewer’s /start to the help they know, but lets them onboard another channel', async () => {
    await db.update(workspaces).set({ telegramChatId: '-1009', telegramAdminChatId: String(ME) }).where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
    expect(await send('/start')).toBe(false);
    expect(await send('/newchannel')).toBe(true);
    expect(await session()).toMatchObject({ status: 'awaiting_channel' });
  });

  it('refreshes a workspace the person already has for that channel, never overwriting the editor’s profile', async () => {
    await db
      .update(workspaces)
      .set({ name: 'Космос', telegramChatId: String(CHANNEL_ID), telegramAdminChatId: String(ME), editorialProfile: 'Written by the editor.', language: 'en' })
      .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
    await addWorkspaceMember(db, DEFAULT_WORKSPACE_ID, { id: ME });

    await send('/newchannel');
    await send('@spacenews');
    expect(lastText()).toMatch(/уже підключено/);
    const { id, workspaceId } = await session();
    expect(workspaceId).toBe(DEFAULT_WORKSPACE_ID);
    expect(await db.select().from(workspaces)).toHaveLength(1);

    await runOnboarding(deps(), { sessionId: id, budgetMs: 60_000, stepTimeMs: 1 });
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
    expect(workspace).toMatchObject({ editorialProfile: 'Written by the editor.', language: 'en', createdVia: 'operator' });
  });

  it('stops at WORKSPACES_PER_USER self-service channels', async () => {
    for (const [index, name] of ['one_channel', 'two_channel', 'three_channel'].entries()) {
      chats[`@${name}`] = { id: -100900 - index, type: 'channel', title: name };
      pages[name] = 3;
      await send(index === 0 ? '/start' : '/newchannel');
      await send(`@${name}`);
      await db.update(onboardingSessions).set({ status: 'active' });
    }
    await send('/newchannel');
    expect(lastText()).toMatch(/до 3 каналів/);
  });
});

describeIfDb('the editorial profile’s author', () => {
  it('is the editor once a person saves it, and nobody once it is cleared', async () => {
    await setEditorialProfile(db, { workspaceId: DEFAULT_WORKSPACE_ID, reviewerWorkspaceIds: [DEFAULT_WORKSPACE_ID], editorialProfile: 'Mine.' });
    expect((await db.select().from(workspaces))[0]).toMatchObject({ editorialProfileSource: 'editor' });
    await setEditorialProfile(db, { workspaceId: DEFAULT_WORKSPACE_ID, reviewerWorkspaceIds: [DEFAULT_WORKSPACE_ID], editorialProfile: '  ' });
    expect((await db.select().from(workspaces))[0]).toMatchObject({ editorialProfile: null, editorialProfileSource: null });
  });
});
