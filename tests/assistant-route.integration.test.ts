import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import { assistantRequests, DEFAULT_WORKSPACE_ID, processedPosts, users, workspaces, type ApprovalPayload } from '@/db/schema';
import type { AssistantStreamEvent } from '@/lib/assistant/events';
import type { AssistantModel, AssistantTurnInput, AssistantTurnResult } from '@/lib/assistant/openai';
import { initialRichDocument } from '@/lib/rich/document';
import { ensureTestWorkspace, withEnv } from './helpers';

/**
 * The editor's assistant endpoint end to end, with the model replaced: who may
 * ask, what the model is shown, how an edit is checked before the editor gets
 * it, and what each request records and is allowed.
 */

const turns: ((input: AssistantTurnInput, emit: (event: AssistantStreamEvent) => void) => AssistantTurnResult)[] = [];
const seen: AssistantTurnInput[] = [];

vi.mock('@/lib/assistant/repository', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/assistant/repository')>();
  const fake: AssistantModel = {
    model: 'gpt-6-luna',
    async runTurn(input, emit) {
      seen.push(input);
      const turn = turns.shift();
      if (!turn) throw new Error('no turn scripted');
      return turn(input, emit);
    },
  };
  return { ...original, createAssistantModel: (env: Parameters<typeof original.createAssistantModel>[0]) => (original.assistantAvailable(env) ? fake : null) };
});

const { POST: assistantRoute } = await import('@/app/api/telegram/webapp/assistant/route');

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

const BOT_TOKEN = '123456:AAHfakeTokenForTestsOnly';
const REVIEWER_ID = 555001;
const STRANGER_ID = 777002;

const env = {
  DATABASE_URL: connectionString,
  DRY_RUN: 'false',
  REQUIRE_APPROVAL: 'true',
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(64),
  APP_BASE_URL: 'https://example.vercel.app',
  OPENAI_API_KEY: 'sk-test',
  ASSISTANT_DAILY_LIMIT: '3',
};

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  if (!connectionString) return;
  sql = postgres(connectionString, { max: 4, prepare: false });
  db = drizzle(sql, { schema });
});

afterAll(async () => {
  if (sql) await sql.end();
  await (globalThis as { __contentArbitrarySql?: postgres.Sql }).__contentArbitrarySql?.end();
});

beforeEach(async () => {
  if (!connectionString) return;
  turns.length = 0;
  seen.length = 0;
  await db.delete(assistantRequests);
  await db.delete(processedPosts);
  await db.delete(users);
  await ensureTestWorkspace(db);
  await db
    .update(workspaces)
    .set({
      name: 'VECTOR',
      telegramChatId: '-1003906212630',
      telegramAdminChatId: String(REVIEWER_ID),
      editorialProfile: 'Space news.',
      language: 'uk',
      postFooter: '[VECTOR](https://t.me/vector)',
    })
    .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
});

function initDataFor(userId: number): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId }),
  };
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const params = new URLSearchParams(fields);
  params.set('hash', createHmac('sha256', secretKey).update(dataCheckString).digest('hex'));
  return params.toString();
}

const PAYLOAD: ApprovalPayload = {
  method: 'sendPhoto',
  caption: 'Curiosity saw a blue dawn on Mars',
  items: [],
  sourceMedia: [{ mediaKey: '3_1', kind: 'photo', url: 'https://cdn.example/3_1.jpg', width: 1600, height: 1200 }],
};

async function post() {
  const [row] = await db
    .insert(processedPosts)
    .values({
      workspaceId: DEFAULT_WORKSPACE_ID,
      xPostId: '1750000000000000042',
      xPostUrl: 'https://x.com/nasa/status/42',
      xAuthorUsername: 'nasa',
      sourceText: 'Curiosity captured a blue sunset on Mars.',
      status: 'awaiting_approval',
      approvalPayload: PAYLOAD,
      reviewQueuedAt: new Date(),
      originalCaption: PAYLOAD.caption,
      caption: PAYLOAD.caption,
    })
    .returning();
  return row!;
}

const draft = initialRichDocument({ text: 'Curiosity saw a blue dawn on Mars', mediaCount: 1 });

async function ask(body: Record<string, unknown>, options: { userId?: number; env?: Record<string, string | undefined> } = {}) {
  return withEnv({ ...env, ...options.env }, async () => {
    const response = await assistantRoute(
      new Request('https://example.vercel.app/api/telegram/webapp/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `tma ${initDataFor(options.userId ?? REVIEWER_ID)}` },
        body: JSON.stringify(body),
      }),
    );
    const text = await response.text();
    const events = response.ok ? text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as AssistantStreamEvent) : [];
    return { status: response.status, events, body: response.ok ? null : (JSON.parse(text) as { error: string }) };
  });
}

const usage = { inputTokens: 2000, outputTokens: 400 };
const answer = (overrides: Partial<AssistantTurnResult> = {}): AssistantTurnResult => ({
  text: '',
  edit: null,
  editError: null,
  sources: [],
  webSearches: 0,
  usage,
  ...overrides,
});

describeIfDb('POST /api/telegram/webapp/assistant', () => {
  it('streams the reply and the checked edit, shows the model the draft and the source, and records the cost', async () => {
    const row = await post();
    turns.push((_, emit) => {
      emit({ type: 'text', delta: 'Скоротив.' });
      return answer({ text: 'Скоротив.', edit: { html: '<media ref="m0"></media><p><b>Блакитний</b> світанок на Марсі</p>', summary: 'Скоротив текст' } });
    });

    const { status, events } = await ask({
      postId: row.id,
      draft,
      message: 'зроби коротше',
      history: [{ role: 'user', text: 'привіт' }, { role: 'assistant', text: 'Привіт!' }],
    });

    expect(status).toBe(200);
    expect(events[0]).toEqual({ type: 'text', delta: 'Скоротив.' });
    expect(events[1]).toEqual({
      type: 'edit',
      summary: 'Скоротив текст',
      doc: {
        type: 'doc',
        content: [
          { type: 'postMedia', attrs: { ref: 'm0', caption: null } },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Блакитний', marks: [{ type: 'bold' }] },
              { type: 'text', text: ' світанок на Марсі' },
            ],
          },
        ],
      },
    });
    expect(events.at(-1)).toEqual({ type: 'done', remaining: 2 });

    const input = seen[0]!;
    expect(input.instructions).toContain('"VECTOR"');
    expect(input.instructions).toContain('Space news.');
    expect(input.context).toContain('Curiosity captured a blue sunset on Mars.');
    expect(input.context).toContain('m0 (photo)');
    expect(input.message).toContain('<media ref="m0"></media>\n<p>Curiosity saw a blue dawn on Mars</p>');
    expect(input.message).toContain('зроби коротше');
    expect(input.history).toEqual([{ role: 'user', text: 'привіт' }, { role: 'assistant', text: 'Привіт!' }]);

    const [record] = await db.select().from(assistantRequests);
    expect(record).toMatchObject({
      workspaceId: DEFAULT_WORKSPACE_ID,
      processedPostId: row.id,
      model: 'gpt-6-luna',
      promptVersion: 'assistant-v1',
      status: 'ok',
      edited: true,
      inputTokens: 2000,
      outputTokens: 400,
    });
    expect(record!.costUsd).toBeCloseTo((2000 * 0.1 + 400 * 0.5) / 1_000_000, 10);
  });

  it('asks once more, saying why, when an edit is not a post the channel can show', async () => {
    const row = await post();
    turns.push(() => answer({ edit: { html: '<media ref="m3"></media><p>x</p>', summary: 'a' } }));
    turns.push(() => answer({ edit: { html: '<media ref="m0"></media><p>Fixed</p>', summary: 'b' } }));

    const { events } = await ask({ postId: row.id, draft, message: 'переклади' });

    expect(seen[1]!.followUp).toContain('A picture that is not this post’s own.');
    expect(events.filter((event) => event.type === 'edit')).toHaveLength(1);
    expect(events.find((event) => event.type === 'edit')).toMatchObject({ summary: 'b' });
    const [record] = await db.select().from(assistantRequests);
    expect(record).toMatchObject({ edited: true, inputTokens: 4000, outputTokens: 800 });
  });

  it('says so, and changes nothing, when the second edit cannot be used either', async () => {
    const row = await post();
    turns.push(() => answer({ editError: 'the edit was not valid JSON.' }));
    turns.push(() => answer({ editError: 'the edit was not valid JSON.' }));

    const { events } = await ask({ postId: row.id, draft, message: 'переклади' });

    expect(events.some((event) => event.type === 'edit')).toBe(false);
    expect(events).toContainEqual({ type: 'error', message: "The assistant's edit could not be used: the edit was not valid JSON." });
  });

  it('records a failure, and tells the editor plainly', async () => {
    const row = await post();
    turns.push(() => {
      throw new Error('OpenAI is down');
    });

    const { status, events } = await ask({ postId: row.id, draft, message: 'перевір факти' });

    expect(status).toBe(200);
    expect(events).toEqual([{ type: 'error', message: 'The assistant could not answer. Try again in a moment.' }]);
    const [record] = await db.select().from(assistantRequests);
    expect(record).toMatchObject({ status: 'failed', error: 'Error: OpenAI is down' });
  });

  it('keeps to the daily limit', async () => {
    const row = await post();
    for (let i = 0; i < 3; i += 1) {
      turns.push(() => answer({ text: 'ok' }));
      expect((await ask({ postId: row.id, draft, message: `q${i}` })).status).toBe(200);
    }
    const refused = await ask({ postId: row.id, draft, message: 'one more' });
    expect(refused.status).toBe(429);
    expect(refused.body!.error).toContain('3 assistant requests');
  });

  it('refuses another channel’s post, a draft the channel cannot show, and an install without the assistant', async () => {
    const row = await post();
    expect((await ask({ postId: row.id, draft, message: 'hi' }, { userId: STRANGER_ID })).status).toBe(401);

    const foreign = { type: 'doc', content: [{ type: 'postMedia', attrs: { ref: 'm4', caption: null } }] };
    expect((await ask({ postId: row.id, draft: foreign, message: 'hi' })).status).toBe(422);

    expect((await ask({ postId: row.id, draft, message: 'hi' }, { env: { OPENAI_API_KEY: undefined } })).status).toBe(503);
    expect((await ask({ postId: row.id, draft, message: 'hi' }, { env: { ASSISTANT_DAILY_LIMIT: '0' } })).status).toBe(503);
    expect(seen).toHaveLength(0);
  });
});
