import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import { botPendingInputs, DEFAULT_WORKSPACE_ID, workspaces } from '@/db/schema';
import { POST as channelsRoute } from '@/app/api/telegram/webapp/channels/route';
import { GET as sourcesRoute } from '@/app/api/telegram/webapp/sources/route';
import { POST as webhookRoute } from '@/app/api/telegram/webhook/route';
import { handlePendingInputMessage, handleProfileCallback, type ProfileContext } from '@/lib/profile/bot-profile';
import type { RadarProvider } from '@/lib/radar/providers/types';
import { TelegramClient } from '@/lib/telegram/client';
import { awaitInput, PENDING_INPUT_TTL_MS } from '@/lib/telegram/pending-input';
import { normaliseLanguageCode } from '@/lib/workspace-language';
import { ensureTestWorkspace, silentLogger, telegramOk, withEnv } from './helpers';

/**
 * The editorial profile in the bot (§14a), against a real database: /profile,
 * ✏️ replacing it with the next message, 💬 rewriting it and saving only on
 * ✅, 🌐 the language — and Settings' language field and its refusal to clear
 * a self-service channel's profile.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

const BOT_TOKEN = '123456:AAHfakeTokenForTestsOnly';
const ME = 555001;
const STRANGER = 777003;
const SECRET = 'b'.repeat(64);
const PROFILE = 'Новини PlayStation: релізи, оновлення, State of Play.';

const env = {
  DATABASE_URL: connectionString,
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  APP_BASE_URL: 'https://example.vercel.app',
  OPENAI_API_KEY: '',
  ANTHROPIC_API_KEY: '',
};

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(() => {
  if (!connectionString) return;
  sql = postgres(connectionString, { max: 4, prepare: false });
  db = drizzle(sql, { schema });
});

afterAll(async () => {
  if (sql) await sql.end();
  await (globalThis as { __contentArbitrarySql?: postgres.Sql }).__contentArbitrarySql?.end();
});

let calls: { method: string; body: Record<string, unknown> }[];

beforeEach(async () => {
  if (!connectionString) return;
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const method = String(input).split('/').pop()!;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ method, body });
      if (method === 'sendMessage') return telegramOk({ message_id: 900 + calls.length, chat: { id: Number(body.chat_id) } });
      return telegramOk(true);
    }),
  );
  await ensureTestWorkspace(db);
  await db
    .update(workspaces)
    .set({
      name: 'PlayStation UA',
      telegramChatId: '-1001000000002',
      telegramAdminChatId: String(ME),
      editorialProfile: PROFILE,
      editorialProfileSource: 'auto',
      language: 'uk',
      createdVia: 'self_service',
    })
    .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const webhook = (update: unknown) =>
  withEnv(env, () =>
    webhookRoute(
      new Request('https://example.vercel.app/api/telegram/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
        body: JSON.stringify(update),
      }),
    ),
  );

const message = (text: string, from = ME) =>
  webhook({ message: { message_id: 1, from: { id: from, language_code: 'uk' }, chat: { id: from, type: 'private' }, text } });

const press = (data: string, from = ME) =>
  webhook({
    callback_query: {
      id: 'q1',
      from: { id: from, language_code: 'uk' },
      data,
      message: { message_id: 42, chat: { id: from } },
    },
  });

const workspace = async () => (await db.select().from(workspaces).where(eq(workspaces.id, DEFAULT_WORKSPACE_ID)))[0]!;
const pending = async () => (await db.select().from(botPendingInputs))[0] ?? null;
const lastText = (method = 'sendMessage') => String(calls.filter((entry) => entry.method === method).at(-1)?.body.text ?? '');
const buttons = (method = 'sendMessage') =>
  ((calls.filter((entry) => entry.method === method).at(-1)?.body.reply_markup as { inline_keyboard?: { callback_data?: string }[][] })
    ?.inline_keyboard ?? [])
    .flat()
    .map((button) => button.callback_data)
    .filter(Boolean);

describeIfDb('/profile in the bot', () => {
  it('shows the profile, marked as written automatically, with its language and buttons', async () => {
    await message('/profile');
    expect(lastText()).toContain('Профіль каналу PlayStation UA');
    expect(lastText()).toContain('(згенерований автоматично)');
    expect(lastText()).toContain(PROFILE);
    expect(lastText()).toContain('Мова постів: українська');
    expect(buttons()).toEqual([`pf:e:${DEFAULT_WORKSPACE_ID}`, `pf:r:${DEFAULT_WORKSPACE_ID}`, `pf:l:${DEFAULT_WORKSPACE_ID}`]);
  });

  it('asks which channel when the sender reviews several', async () => {
    const [second] = await db
      .insert(workspaces)
      .values({ name: 'Second', telegramChatId: '-1001000000003', telegramAdminChatId: String(ME) })
      .returning();
    await message('/profile');
    expect(lastText()).toBe('Профіль якого каналу?');
    expect(buttons()).toEqual([`pf:s:${DEFAULT_WORKSPACE_ID}`, `pf:s:${second!.id}`]);
    await press(`pf:s:${second!.id}`);
    expect(lastText()).toContain('Профіль каналу Second');
  });

  it('✏️ replaces the profile with the next message, as the editor’s', async () => {
    await press(`pf:e:${DEFAULT_WORKSPACE_ID}`);
    expect(lastText()).toContain('Надішли новий текст профілю');
    expect((await pending())?.kind).toBe('profile_replace');

    await message('Лише ексклюзиви PlayStation і великі релізи. Без чуток.');
    const row = await workspace();
    expect(row.editorialProfile).toBe('Лише ексклюзиви PlayStation і великі релізи. Без чуток.');
    expect(row.editorialProfileSource).toBe('editor');
    expect(await pending()).toBeNull();
    expect(lastText()).toContain('Збережено. Нові пости оцінюватиму за оновленим профілем.');
    expect(lastText()).not.toContain('згенерований автоматично');
  });

  it('refuses a profile over 2,000 characters, saying by how much, and keeps waiting', async () => {
    await press(`pf:e:${DEFAULT_WORKSPACE_ID}`);
    await message('я'.repeat(2_005));
    expect(lastText()).toContain('Задовго на 5 символів');
    expect((await workspace()).editorialProfile).toBe(PROFILE);
    expect((await pending())?.kind).toBe('profile_replace');
  });

  it('lets a /command cancel the wait and run as usual', async () => {
    await press(`pf:e:${DEFAULT_WORKSPACE_ID}`);
    await message('/review');
    expect(await pending()).toBeNull();
    expect(lastText()).toMatch(/waiting for review/i);
    expect((await workspace()).editorialProfile).toBe(PROFILE);
  });

  it('ignores a prompt that has lapsed', async () => {
    await awaitInput(db, {
      telegramUserId: String(ME),
      kind: 'profile_replace',
      workspaceId: DEFAULT_WORKSPACE_ID,
      now: new Date(Date.now() - PENDING_INPUT_TTL_MS - 1_000),
    });
    await message('Це просто повідомлення');
    expect((await workspace()).editorialProfile).toBe(PROFILE);
  });

  it('↩️ cancels, and nothing changes', async () => {
    await press(`pf:e:${DEFAULT_WORKSPACE_ID}`);
    await press(`pf:x:${DEFAULT_WORKSPACE_ID}`);
    expect(await pending()).toBeNull();
    await message('Новий текст');
    expect((await workspace()).editorialProfile).toBe(PROFILE);
  });

  it('🌐 sets the language from the list, “as is”, or a typed code', async () => {
    await press(`pf:l:${DEFAULT_WORKSPACE_ID}`);
    expect(buttons('editMessageText')).toEqual([
      `pf:L:${DEFAULT_WORKSPACE_ID}:uk`,
      `pf:L:${DEFAULT_WORKSPACE_ID}:en`,
      `pf:L:${DEFAULT_WORKSPACE_ID}:-`,
      `pf:o:${DEFAULT_WORKSPACE_ID}`,
      `pf:x:${DEFAULT_WORKSPACE_ID}`,
    ]);

    await press(`pf:L:${DEFAULT_WORKSPACE_ID}:en`);
    expect((await workspace()).language).toBe('en');
    expect(lastText('editMessageText')).toContain('Мову змінено: англійська');

    await press(`pf:L:${DEFAULT_WORKSPACE_ID}:-`);
    expect((await workspace()).language).toBeNull();

    await press(`pf:o:${DEFAULT_WORKSPACE_ID}`);
    await message('xx');
    expect(lastText()).toContain('Не знаю такої мови');
    expect((await workspace()).language).toBeNull();
    await message('PT_br');
    expect((await workspace()).language).toBe('pt-BR');
    expect(await pending()).toBeNull();
  });

  it('refuses someone else’s channel, and their message is not an input', async () => {
    await press(`pf:e:${DEFAULT_WORKSPACE_ID}`, STRANGER);
    expect(calls.find((entry) => entry.method === 'answerCallbackQuery')?.body.text).toBe('Це не твій канал.');
    expect(await pending()).toBeNull();

    await press(`pf:L:${DEFAULT_WORKSPACE_ID}:en`, STRANGER);
    expect((await workspace()).language).toBe('uk');
  });

  it('puts a 📝 button on the “Стежу за” message', async () => {
    const { followingKeyboard } = await import('@/lib/onboarding/following');
    const keyboard = followingKeyboard('uk', { workspaceId: 7, active: [], connected: true });
    expect(keyboard.inline_keyboard.flat()).toContainEqual({ text: '📝 Профіль каналу', callback_data: 'pf:s:7' });
  });
});

describeIfDb('💬 refining the profile', () => {
  const instructions: string[] = [];
  const provider = {
    name: 'openai',
    model: 'fake',
    complete: vi.fn(async (request: { input: string }) => {
      instructions.push(request.input);
      const current = /<current_profile>\n([\s\S]*?)\n<\/current_profile>/.exec(request.input)![1]!;
      const asked = /<instruction>\n([\s\S]*?)\n<\/instruction>/.exec(request.input)![1]!;
      return { output: { editorialProfile: `${current} ${asked}.` }, usage: {} };
    }),
  } as unknown as RadarProvider;

  const context = (): ProfileContext => ({
    db,
    client: new TelegramClient({ token: BOT_TOKEN, baseUrl: 'https://api.telegram.org', logger: silentLogger }),
    logger: silentLogger,
    provider,
  });
  const from = { id: ME, language_code: 'uk' };
  const chat = { id: ME, type: 'private' };
  const callback = (data: string) =>
    handleProfileCallback({ id: 'q', from, data, message: { message_id: 42, chat: { id: ME } } }, context());

  beforeEach(() => {
    instructions.length = 0;
  });

  it('rewrites from the instruction, shows the draft, and saves only on ✅', async () => {
    await callback(`pf:r:${DEFAULT_WORKSPACE_ID}`);
    expect(lastText()).toContain('Напиши, що змінити');

    await handlePendingInputMessage({ chat, from, text: 'Без знижок і розіграшів' }, context());
    expect(instructions[0]).toContain(PROFILE);
    expect(lastText('editMessageText')).toContain('Ось новий варіант:');
    expect(lastText('editMessageText')).toContain(`${PROFILE} Без знижок і розіграшів.`);
    expect(buttons('editMessageText')).toEqual([
      `pf:ok:${DEFAULT_WORKSPACE_ID}`,
      `pf:x:${DEFAULT_WORKSPACE_ID}`,
      `pf:m:${DEFAULT_WORKSPACE_ID}`,
    ]);
    // Not saved yet.
    expect((await workspace()).editorialProfile).toBe(PROFILE);

    // 💬 Ще уточнити: the next instruction applies to the draft.
    await callback(`pf:m:${DEFAULT_WORKSPACE_ID}`);
    await handlePendingInputMessage({ chat, from, text: 'Більше інді' }, context());
    expect(instructions[1]).toContain(`${PROFILE} Без знижок і розіграшів.`);

    await callback(`pf:ok:${DEFAULT_WORKSPACE_ID}`);
    const row = await workspace();
    expect(row.editorialProfile).toBe(`${PROFILE} Без знижок і розіграшів. Більше інді.`);
    expect(row.editorialProfileSource).toBe('editor');
    expect(await pending()).toBeNull();
    expect(lastText('editMessageText')).toContain('Збережено.');
  });

  it('↩️ drops the draft', async () => {
    await callback(`pf:r:${DEFAULT_WORKSPACE_ID}`);
    await handlePendingInputMessage({ chat, from, text: 'Коротше' }, context());
    await callback(`pf:x:${DEFAULT_WORKSPACE_ID}`);
    await callback(`pf:ok:${DEFAULT_WORKSPACE_ID}`);
    expect((await workspace()).editorialProfile).toBe(PROFILE);
  });

  it('says so when no model is configured', async () => {
    await callback(`pf:r:${DEFAULT_WORKSPACE_ID}`);
    await handlePendingInputMessage({ chat, from, text: 'Коротше' }, { ...context(), provider: null });
    expect(lastText()).toContain('Переписувати профіль зараз нікому');
    expect(await pending()).toBeNull();
  });
});

describeIfDb('Settings: language, and a self-service profile', () => {
  function initDataFor(userId: number): string {
    const fields: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId }) };
    const dataCheckString = Object.keys(fields)
      .sort()
      .map((key) => `${key}=${fields[key]}`)
      .join('\n');
    const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const params = new URLSearchParams(fields);
    params.set('hash', createHmac('sha256', secretKey).update(dataCheckString).digest('hex'));
    return params.toString();
  }
  const call = (route: (request: Request) => Promise<Response>, method: string, body?: unknown) =>
    withEnv(env, () =>
      route(
        new Request('https://example.vercel.app/api/telegram/webapp/channels', {
          method,
          headers: { authorization: `tma ${initDataFor(ME)}`, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      ),
    );

  it('lists the language, the auto badge and whether the profile can be cleared', async () => {
    const response = await call(sourcesRoute as (request: Request) => Promise<Response>, 'GET');
    const body = (await response.json()) as { channels: Record<string, unknown>[] };
    expect(body.channels[0]).toMatchObject({ language: 'uk', editorialProfileAuto: true, profileClearable: false });
  });

  it('sets the language, normalised, or none; refuses an unknown code', async () => {
    let response = await call(channelsRoute, 'POST', { workspaceId: DEFAULT_WORKSPACE_ID, language: 'de' });
    expect(await response.json()).toMatchObject({ language: 'de' });
    response = await call(channelsRoute, 'POST', { workspaceId: DEFAULT_WORKSPACE_ID, language: 'pt_br' });
    expect(await response.json()).toMatchObject({ language: 'pt-BR' });
    response = await call(channelsRoute, 'POST', { workspaceId: DEFAULT_WORKSPACE_ID, language: 'xx' });
    expect(response.status).toBe(422);
    response = await call(channelsRoute, 'POST', { workspaceId: DEFAULT_WORKSPACE_ID, language: null });
    expect(await response.json()).toMatchObject({ language: null });
    expect((await workspace()).language).toBeNull();
  });

  it('refuses to clear a self-service channel’s profile, but an operator’s may be cleared', async () => {
    let response = await call(channelsRoute, 'POST', { workspaceId: DEFAULT_WORKSPACE_ID, editorialProfile: '   ' });
    expect(response.status).toBe(422);
    expect((await workspace()).editorialProfile).toBe(PROFILE);

    response = await call(channelsRoute, 'POST', { workspaceId: DEFAULT_WORKSPACE_ID, editorialProfile: 'Новий' });
    expect(await response.json()).toMatchObject({ editorialProfile: 'Новий', editorialProfileAuto: false });

    await db.update(workspaces).set({ createdVia: 'operator' }).where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
    response = await call(channelsRoute, 'POST', { workspaceId: DEFAULT_WORKSPACE_ID, editorialProfile: null });
    expect(response.status).toBe(200);
    expect((await workspace()).editorialProfile).toBeNull();
  });
});

describe('language codes', () => {
  it('normalises what people type and refuses what no one speaks', () => {
    expect(normaliseLanguageCode(' UK ')).toBe('uk');
    expect(normaliseLanguageCode('pt_br')).toBe('pt-BR');
    expect(normaliseLanguageCode('xx')).toBeNull();
    expect(normaliseLanguageCode('Українська')).toBeNull();
    expect(normaliseLanguageCode('')).toBeNull();
  });
});
