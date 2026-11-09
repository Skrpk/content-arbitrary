import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import { DEFAULT_WORKSPACE_ID, threadsAccounts, threadsConnectAttempts, users, workspaces } from '@/db/schema';
import { GET as startRoute } from '@/app/api/threads/start/route';
import { GET as callbackRoute } from '@/app/api/threads/callback/route';
import { POST as deauthorizeRoute } from '@/app/api/threads/deauthorize/route';
import { GET as deletionStatusRoute, POST as deleteRoute } from '@/app/api/threads/delete/route';
import { DELETE as disconnectRoute, GET as accountsRoute } from '@/app/api/threads/accounts/route';
import { createSession } from '@/lib/accounts/sessions';
import { userForTelegram } from '@/lib/accounts/users';
import { threadsAccessToken } from '@/lib/threads/accounts';
import { refreshThreadsTokens, THREADS_REFRESH_AFTER_MS } from '@/lib/threads/refresh';
import { encryptToken } from '@/lib/threads/token-crypto';
import { createTestLogger, ensureTestWorkspace, withEnv } from './helpers';

/**
 * Connecting a channel's Threads account end to end, against a stand-in for
 * Meta: the website's button, Meta's authorization window and its callback,
 * the token kept encrypted and refreshed, the settings that list and
 * disconnect it, and Meta's own calls to forget someone.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

const WEB = 'https://app.example.com';
const BOT_TOKEN = '123456:AAHfakeTokenForTestsOnly';
const APP_ID = '4645779255666888';
const APP_SECRET = 'threads-app-secret-for-tests-0123456789';
const REVIEWER_ID = 555001;
const OTHER_REVIEWER_ID = 555002;
const OTHER_WORKSPACE_ID = 2;
const THREADS_USER_ID = '17841405793187218';

const env = {
  DATABASE_URL: connectionString,
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_CHAT_ID: '-1001000000001',
  REQUIRE_APPROVAL: 'true',
  TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(64),
  APP_BASE_URL: 'https://mini.example.com',
  WEB_APP_URL: WEB,
  THREADS_APP_ID: APP_ID,
  THREADS_APP_SECRET: APP_SECRET,
};
const app = { appId: APP_ID, appSecret: APP_SECRET, redirectUri: `${WEB}/api/threads/callback` };

let graphCalls: string[];
let username: string;
let failRefresh: boolean;

/** Meta's Graph API for Threads, as connecting uses it. */
function stubThreads() {
  const fetchImpl = vi.fn(async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    graphCalls.push(url.split('?')[0]!);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url === 'https://graph.threads.com/oauth/access_token') return ok({ access_token: 'short-token', token_type: 'bearer', user_id: 1 });
    if (url.startsWith('https://graph.threads.com/access_token?')) return ok({ access_token: 'long-token', token_type: 'bearer', expires_in: 5_184_000 });
    if (url.startsWith('https://graph.threads.com/refresh_access_token?')) {
      return failRefresh
        ? new Response(JSON.stringify({ error: { message: 'Session has expired' } }), { status: 400 })
        : ok({ access_token: 'refreshed-token', token_type: 'bearer', expires_in: 5_184_000 });
    }
    if (url.startsWith('https://graph.threads.com/v1.0/me?')) return ok({ id: THREADS_USER_ID, username });
    return new Response('not stubbed', { status: 500 });
  });
  vi.stubGlobal('fetch', fetchImpl);
  return fetchImpl;
}

function cookiesOf(response: Response): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const index = pair!.indexOf('=');
    jar[pair!.slice(0, index)] = pair!.slice(index + 1);
  }
  return jar;
}

async function sessionFor(telegramId: number): Promise<string> {
  const user = await userForTelegram(db, { id: String(telegramId), name: null, username: null });
  return (await createSession(db, { userId: user!.id })).token;
}

const run = <T>(fn: () => Promise<T>) => withEnv(env, fn);

/** Press "Connect Threads" for a channel, signed in with this session: the response. */
function start(session: string | null, workspaceId = DEFAULT_WORKSPACE_ID) {
  return run(() =>
    startRoute(
      new Request(`${WEB}/api/threads/start?workspaceId=${workspaceId}`, {
        headers: session ? { cookie: `__Host-session=${session}` } : {},
      }),
    ),
  );
}

function callback(query: string, cookie: string) {
  return run(() => callbackRoute(new Request(`${WEB}/api/threads/callback?${query}`, { headers: { cookie } })));
}

/** Connect, all the way: the callback's response. */
async function connect(session: string, workspaceId = DEFAULT_WORKSPACE_ID) {
  const started = await start(session, workspaceId);
  const state = new URL(started.headers.get('location')!).searchParams.get('state')!;
  const stateCookie = cookiesOf(started)['__Host-threads-state']!;
  return callback(`code=AQBx-code&state=${state}`, `__Host-session=${session}; __Host-threads-state=${stateCookie}`);
}

function signedRequest(threadsUserId: string, secret = APP_SECRET): string {
  const payload = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', issued_at: 1, user_id: threadsUserId })).toString('base64url');
  return `${createHmac('sha256', secret).update(payload).digest('base64url')}.${payload}`;
}

function metaPost(route: (request: Request) => Promise<Response>, path: string, signed: string) {
  return run(() => route(new Request(`${WEB}${path}`, { method: 'POST', body: new URLSearchParams({ signed_request: signed }) })));
}

beforeAll(() => {
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
  graphCalls = [];
  username = 'zmistik';
  failRefresh = false;
  await db.delete(threadsAccounts);
  await db.delete(threadsConnectAttempts);
  await db.delete(users);
  await ensureTestWorkspace(db);
  await db
    .update(workspaces)
    .set({ name: 'Space news', telegramChatId: '-1001000000001', telegramAdminChatId: String(REVIEWER_ID) })
    .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
  await db.insert(workspaces).values({
    id: OTHER_WORKSPACE_ID,
    name: 'Someone else',
    telegramChatId: '-1001000000002',
    telegramAdminChatId: String(OTHER_REVIEWER_ID),
  });
  stubThreads();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describeIfDb('connecting a channel’s Threads account', () => {
  it('sends the browser to Meta for the channel, and back to settings with the account stored encrypted', async () => {
    const session = await sessionFor(REVIEWER_ID);
    const started = await start(session);
    expect(started.status).toBe(303);
    const location = new URL(started.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe('https://threads.com/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe(APP_ID);
    expect(location.searchParams.get('redirect_uri')).toBe(`${WEB}/api/threads/callback`);
    expect(location.searchParams.get('scope')).toBe('threads_basic,threads_content_publish');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(cookiesOf(started)['__Host-threads-state']).toBe(location.searchParams.get('state'));

    const done = await callback(
      `code=AQBx-code&state=${location.searchParams.get('state')}`,
      `__Host-session=${session}; __Host-threads-state=${location.searchParams.get('state')}`,
    );
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe(`${WEB}/settings?threads=connected`);
    expect(cookiesOf(done)['__Host-threads-state']).toBe('');

    const [account] = await db.select().from(threadsAccounts);
    expect(account).toMatchObject({ workspaceId: DEFAULT_WORKSPACE_ID, threadsUserId: THREADS_USER_ID, username: 'zmistik', lastError: null });
    expect(account!.accessTokenEncrypted).not.toContain('long-token');
    expect(threadsAccessToken(account!, app)).toBe('long-token');
    expect(account!.tokenExpiresAt.getTime() - Date.now()).toBeGreaterThan(59 * 24 * 3600 * 1000);
    expect(await db.select().from(threadsConnectAttempts)).toHaveLength(0);
  });

  it('lists it in settings, on the website and in the Mini App, and disconnects it', async () => {
    const session = await sessionFor(REVIEWER_ID);
    await connect(session);

    const listed = await run(() => accountsRoute(new Request(`${WEB}/api/threads/accounts`, { headers: { cookie: `__Host-session=${session}` } })));
    expect(await listed.json()).toMatchObject({
      configured: true,
      via: 'website',
      websiteUrl: WEB,
      accounts: [{ workspaceId: DEFAULT_WORKSPACE_ID, username: 'zmistik', status: 'active' }],
    });

    const gone = await run(() =>
      disconnectRoute(
        new Request(`${WEB}/api/threads/accounts`, {
          method: 'DELETE',
          headers: { cookie: `__Host-session=${session}`, origin: WEB, 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId: DEFAULT_WORKSPACE_ID }),
        }),
      ),
    );
    expect(gone.status).toBe(200);
    expect(await db.select().from(threadsAccounts)).toHaveLength(0);
  });

  it('replaces the channel’s account when connected again', async () => {
    const session = await sessionFor(REVIEWER_ID);
    await connect(session);
    username = 'zmistik_two';
    await connect(session);
    const accounts = await db.select().from(threadsAccounts);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.username).toBe('zmistik_two');
  });

  it('is not started for a channel the reviewer does not review, nor signed out', async () => {
    const session = await sessionFor(REVIEWER_ID);
    const notTheirs = await start(session, OTHER_WORKSPACE_ID);
    expect(notTheirs.headers.get('location')).toBe(`${WEB}/settings?threads=failed`);

    const signedOut = await start(null);
    expect(signedOut.headers.get('location')).toBe(`${WEB}/login?returnTo=%2Fsettings`);
    expect(await db.select().from(threadsConnectAttempts)).toHaveLength(0);
  });

  it('is refused back from Meta without this browser’s state, and used once', async () => {
    const session = await sessionFor(REVIEWER_ID);
    const started = await start(session);
    const state = new URL(started.headers.get('location')!).searchParams.get('state')!;

    const noCookie = await callback(`code=AQBx-code&state=${state}`, `__Host-session=${session}`);
    expect(noCookie.headers.get('location')).toBe(`${WEB}/settings?threads=expired`);
    expect(graphCalls).toHaveLength(0);

    const cookie = `__Host-session=${session}; __Host-threads-state=${state}`;
    expect((await callback(`code=AQBx-code&state=${state}`, cookie)).headers.get('location')).toBe(`${WEB}/settings?threads=connected`);
    expect((await callback(`code=AQBx-code&state=${state}`, cookie)).headers.get('location')).toBe(`${WEB}/settings?threads=expired`);
  });

  it('is refused when someone else is signed in by the time it comes back', async () => {
    const session = await sessionFor(REVIEWER_ID);
    const started = await start(session);
    const state = new URL(started.headers.get('location')!).searchParams.get('state')!;
    const other = await sessionFor(OTHER_REVIEWER_ID);
    const done = await callback(`code=AQBx-code&state=${state}`, `__Host-session=${other}; __Host-threads-state=${state}`);
    expect(done.headers.get('location')).toBe(`${WEB}/settings?threads=expired`);
    expect(await db.select().from(threadsAccounts)).toHaveLength(0);
  });

  it('says so when permission was not given', async () => {
    const session = await sessionFor(REVIEWER_ID);
    const done = await callback('error=access_denied&error_reason=user_denied', `__Host-session=${session}`);
    expect(done.headers.get('location')).toBe(`${WEB}/settings?threads=denied`);
  });

  it('does not disconnect another channel’s account', async () => {
    const other = await sessionFor(OTHER_REVIEWER_ID);
    await connect(other, OTHER_WORKSPACE_ID);
    const session = await sessionFor(REVIEWER_ID);
    const refused = await run(() =>
      disconnectRoute(
        new Request(`${WEB}/api/threads/accounts`, {
          method: 'DELETE',
          headers: { cookie: `__Host-session=${session}`, origin: WEB, 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId: OTHER_WORKSPACE_ID }),
        }),
      ),
    );
    expect(refused.status).toBe(404);
    expect(await db.select().from(threadsAccounts)).toHaveLength(1);
  });
});

describeIfDb('Meta asking to forget someone', () => {
  it('disconnects them from every channel when they remove the app', async () => {
    await connect(await sessionFor(REVIEWER_ID));
    await connect(await sessionFor(OTHER_REVIEWER_ID), OTHER_WORKSPACE_ID);

    const forged = await metaPost(deauthorizeRoute, '/api/threads/deauthorize', signedRequest(THREADS_USER_ID, 'not-the-app-secret-0123'));
    expect(forged.status).toBe(400);
    expect(await db.select().from(threadsAccounts)).toHaveLength(2);

    const done = await metaPost(deauthorizeRoute, '/api/threads/deauthorize', signedRequest(THREADS_USER_ID));
    expect(done.status).toBe(200);
    expect(await db.select().from(threadsAccounts)).toHaveLength(0);
  });

  it('deletes their data and answers with a status page and a code', async () => {
    await connect(await sessionFor(REVIEWER_ID));
    const answer = await metaPost(deleteRoute, '/api/threads/delete', signedRequest(THREADS_USER_ID));
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { url: string; confirmation_code: string };
    expect(body.confirmation_code).toMatch(/^[0-9a-z]+$/);
    expect(body.url).toBe(`${WEB}/api/threads/delete?code=${body.confirmation_code}`);
    expect(await db.select().from(threadsAccounts)).toHaveLength(0);

    const status = await run(() => deletionStatusRoute(new Request(body.url)));
    expect(status.status).toBe(200);
    expect(await status.text()).toContain('Status: completed');
    const unknown = await run(() => deletionStatusRoute(new Request(`${WEB}/api/threads/delete?code=0000000000aaaaaaaaaaaaaaaaaaaa`)));
    expect(unknown.status).toBe(404);
  });
});

describeIfDb('keeping a token fresh', () => {
  async function account(refreshedDaysAgo: number) {
    const now = Date.now();
    const [row] = await db
      .insert(threadsAccounts)
      .values({
        workspaceId: DEFAULT_WORKSPACE_ID,
        threadsUserId: THREADS_USER_ID,
        username: 'zmistik',
        accessTokenEncrypted: encryptToken('old-token', APP_SECRET),
        tokenExpiresAt: new Date(now + (60 - refreshedDaysAgo) * 24 * 3600 * 1000),
        tokenRefreshedAt: new Date(now - refreshedDaysAgo * 24 * 3600 * 1000),
        scopes: ['threads_basic', 'threads_content_publish'],
      })
      .returning();
    return row!;
  }

  it('refreshes one a week old, and leaves a newer one alone', async () => {
    await account(8);
    const logger = createTestLogger();
    expect(await refreshThreadsTokens(db, app, { logger })).toEqual({ refreshed: 1, failed: 0 });
    const [row] = await db.select().from(threadsAccounts);
    expect(threadsAccessToken(row!, app)).toBe('refreshed-token');
    expect(Date.now() - row!.tokenRefreshedAt.getTime()).toBeLessThan(THREADS_REFRESH_AFTER_MS);

    graphCalls = [];
    expect(await refreshThreadsTokens(db, app, { logger })).toEqual({ refreshed: 0, failed: 0 });
    expect(graphCalls).toHaveLength(0);
  });

  it('keeps the old token and says why when a refresh fails, and shows it in settings', async () => {
    await account(8);
    failRefresh = true;
    const logger = createTestLogger();
    expect(await refreshThreadsTokens(db, app, { logger })).toEqual({ refreshed: 0, failed: 1 });
    const [row] = await db.select().from(threadsAccounts);
    expect(threadsAccessToken(row!, app)).toBe('old-token');
    expect(row!.lastError).toContain('Session has expired');
    expect(JSON.stringify(logger.entries)).not.toContain('old-token');

    const session = await sessionFor(REVIEWER_ID);
    const listed = await run(() => accountsRoute(new Request(`${WEB}/api/threads/accounts`, { headers: { cookie: `__Host-session=${session}` } })));
    expect(await listed.json()).toMatchObject({ accounts: [{ status: 'refresh_failed' }] });
  });
});
