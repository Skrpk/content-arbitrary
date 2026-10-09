import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import {
  DEFAULT_WORKSPACE_ID,
  loginAttempts,
  processedPosts,
  sources,
  syncState,
  telegramMessages,
  userSessions,
  users,
  workspaceMembers,
  workspaces,
} from '@/db/schema';
import { GET as startRoute } from '@/app/api/auth/telegram/start/route';
import { GET as callbackRoute } from '@/app/api/auth/telegram/callback/route';
import { POST as logoutRoute } from '@/app/api/auth/logout/route';
import { GET as queueRoute, POST as decideRoute } from '@/app/api/telegram/webapp/queue/route';
import { finishLogin, resetOidcCache, startLogin, type OidcProvider } from '@/lib/accounts/oidc';
import { createSession, SESSION_TTL_MS, userForSession } from '@/lib/accounts/sessions';
import { userForTelegram, workspacesForUser } from '@/lib/accounts/users';
import { ensureTestWorkspace, withEnv } from './helpers';

/**
 * Signing in to the website end to end, against a stand-in for Telegram's
 * OpenID Connect provider that signs its ID tokens with a key made here: the
 * redirect out, the callback, the session, and the API that session opens —
 * alongside the Mini App's own way in, which must keep working.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

const ISSUER = 'https://oauth.telegram.org';
const CLIENT_ID = '8000000001';
const WEB = 'https://app.example.com';
const BOT_TOKEN = '123456:AAHfakeTokenForTestsOnly';
const REVIEWER_ID = 555001;
const STRANGER_ID = 424242;

const env = {
  DATABASE_URL: connectionString,
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_CHAT_ID: '-1001000000001',
  REQUIRE_APPROVAL: 'true',
  TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(64),
  APP_BASE_URL: 'https://mini.example.com',
  WEB_APP_URL: WEB,
  TELEGRAM_OIDC_CLIENT_ID: CLIENT_ID,
  TELEGRAM_OIDC_CLIENT_SECRET: 'client-secret-for-tests',
};

const provider: OidcProvider = {
  id: 'telegram',
  issuer: ISSUER,
  clientId: CLIENT_ID,
  clientSecret: 'client-secret-for-tests',
  scopes: ['openid', 'profile'],
};

let privateKey: CryptoKey;
let publicJwk: JWK;

/** The ID token the stand-in hands back, for whoever the test says signed in. */
let nextClaims: Record<string, unknown>;
let tokenRequests: { authorization: string | null; body: URLSearchParams }[];

async function idToken(claims: Record<string, unknown>, options: { issuer?: string; audience?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? CLIENT_ID)
    .setSubject('1234123412341234123')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

/** Telegram's OIDC endpoints, and whatever else the routes fetch. */
function stubTelegram(overrides: { issuer?: string; audience?: string } = {}) {
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const ok = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return ok({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/auth`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      });
    }
    if (url === `${ISSUER}/.well-known/jwks.json`) return ok({ keys: [publicJwk] });
    if (url === `${ISSUER}/token`) {
      tokenRequests.push({
        authorization: new Headers(init?.headers).get('authorization'),
        body: new URLSearchParams(String(init?.body)),
      });
      return ok({ access_token: 'x', token_type: 'Bearer', expires_in: 3600, id_token: await idToken(nextClaims, overrides) });
    }
    // Anything the queue API sends to Telegram's Bot API.
    return ok({ ok: true, result: true });
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

/** Click "Log in with Telegram", approve at Telegram, come back: the response to the callback. */
async function signIn(claims: Record<string, unknown>, returnTo = '/queue') {
  nextClaims = claims;
  const start = await withEnv(env, () =>
    startRoute(new Request(`${WEB}/api/auth/telegram/start?returnTo=${encodeURIComponent(returnTo)}`)),
  );
  expect(start.status).toBe(303);
  const location = new URL(start.headers.get('location')!);
  const stateCookie = cookiesOf(start)['__Host-login-state']!;
  const state = location.searchParams.get('state')!;

  const callback = await withEnv(env, () =>
    callbackRoute(
      new Request(`${WEB}/api/auth/telegram/callback?code=the-code&state=${state}`, {
        headers: { cookie: `__Host-login-state=${stateCookie}` },
      }),
    ),
  );
  return { start, location, state, callback };
}

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

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'test', alg: 'RS256', use: 'sig' };
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
  resetOidcCache();
  tokenRequests = [];
  await db.delete(telegramMessages);
  await db.delete(processedPosts);
  await db.delete(syncState);
  await db.delete(sources);
  await db.delete(loginAttempts);
  await db.delete(users);
  await ensureTestWorkspace(db);
  await db
    .update(workspaces)
    .set({ telegramChatId: '-1001000000001', telegramAdminChatId: String(REVIEWER_ID) })
    .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describeIfDb('signing in to the website with Telegram', () => {
  it('sends the browser to Telegram with PKCE, and back to the queue with a session', async () => {
    stubTelegram();
    const { start, location, callback } = await signIn({ id: REVIEWER_ID, name: 'Vita', preferred_username: 'vita' });

    expect(location.origin + location.pathname).toBe(`${ISSUER}/auth`);
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: `${WEB}/api/auth/telegram/callback`,
      response_type: 'code',
      scope: 'openid profile',
      code_challenge_method: 'S256',
    });
    expect(start.headers.getSetCookie()[0]).toMatch(/^__Host-login-state=.+; Path=\/; HttpOnly; Secure; SameSite=Lax/);

    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe(`${WEB}/queue`);
    const jar = cookiesOf(callback);
    expect(jar['__Host-session']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(jar['__Host-login-state']).toBe('');

    // The code was exchanged with the secret and the PKCE verifier.
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]!.authorization).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:client-secret-for-tests`).toString('base64')}`,
    );
    expect(tokenRequests[0]!.body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const user = await userForSession(db, jar['__Host-session']!);
    expect(user?.displayName).toBe('Vita');
    expect((await workspacesForUser(db, user!.id)).map((workspace) => workspace.id)).toEqual([DEFAULT_WORKSPACE_ID]);
  });

  it('opens the shared API to that session, but not to a change from another site', async () => {
    stubTelegram();
    const { callback } = await signIn({ id: REVIEWER_ID });
    const cookie = `__Host-session=${cookiesOf(callback)['__Host-session']}`;

    const list = await withEnv(env, () => queueRoute(new Request(`${WEB}/api/telegram/webapp/queue`, { headers: { cookie } })));
    expect(list.status).toBe(200);

    const post = (
      await db
        .insert(processedPosts)
        .values({
          workspaceId: DEFAULT_WORKSPACE_ID,
          xPostId: '1750000000000000077',
          xPostUrl: 'https://x.com/a/status/1750000000000000077',
          status: 'awaiting_approval',
          approvalPayload: { method: 'sendMessage', caption: 'Hi', items: [] },
          originalCaption: 'Hi',
          caption: 'Hi',
        })
        .returning()
    )[0]!;
    const reject = (origin: string) =>
      withEnv(env, () =>
        decideRoute(
          new Request(`${WEB}/api/telegram/webapp/queue`, {
            method: 'POST',
            headers: { cookie, origin, 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'reject', postId: post.id, reason: 'too_minor' }),
          }),
        ),
      );

    expect((await reject('https://evil.example')).status).toBe(403);
    expect((await db.select().from(processedPosts).where(eq(processedPosts.id, post.id)))[0]!.status).toBe('awaiting_approval');
    expect((await reject(WEB)).status).toBe(200);
  });

  it('turns away a Telegram account that reviews nothing, without making it a user', async () => {
    stubTelegram();
    const { callback } = await signIn({ id: STRANGER_ID });

    expect(callback.headers.get('location')).toBe(`${WEB}/login?error=not-a-reviewer`);
    expect(cookiesOf(callback)['__Host-session']).toBeUndefined();
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it('refuses a callback this browser did not start', async () => {
    stubTelegram();
    nextClaims = { id: REVIEWER_ID };
    const start = await withEnv(env, () => startRoute(new Request(`${WEB}/api/auth/telegram/start`)));
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;

    // Another browser's cookie — or none — with this state.
    for (const cookie of ['__Host-login-state=someone-else', '']) {
      const callback = await withEnv(env, () =>
        callbackRoute(new Request(`${WEB}/api/auth/telegram/callback?code=c&state=${state}`, { headers: { cookie } })),
      );
      expect(callback.headers.get('location')).toBe(`${WEB}/login?error=expired`);
    }
    expect(tokenRequests).toHaveLength(0);
  });

  it('uses a sign-in once: replaying the callback gets nothing', async () => {
    stubTelegram();
    const { state, start } = await signIn({ id: REVIEWER_ID });
    const replay = await withEnv(env, () =>
      callbackRoute(
        new Request(`${WEB}/api/auth/telegram/callback?code=the-code&state=${state}`, {
          headers: { cookie: `__Host-login-state=${cookiesOf(start)['__Host-login-state']}` },
        }),
      ),
    );
    expect(replay.headers.get('location')).toBe(`${WEB}/login?error=expired`);
  });

  it('refuses an ID token from another issuer or for another client', async () => {
    for (const overrides of [{ issuer: 'https://evil.example' }, { audience: '999' }]) {
      resetOidcCache();
      stubTelegram(overrides);
      const { callback } = await signIn({ id: REVIEWER_ID });
      expect(callback.headers.get('location')).toBe(`${WEB}/login?error=failed`);
      expect(cookiesOf(callback)['__Host-session']).toBeUndefined();
    }
  });

  it('refuses an ID token carrying another sign-in’s nonce', async () => {
    stubTelegram();
    const { callback } = await signIn({ id: REVIEWER_ID, nonce: 'not-ours' });
    expect(callback.headers.get('location')).toBe(`${WEB}/login?error=failed`);
  });

  it('says so when Telegram sign-in is not configured', async () => {
    const response = await withEnv({ ...env, TELEGRAM_OIDC_CLIENT_SECRET: undefined }, () =>
      startRoute(new Request(`${WEB}/api/auth/telegram/start`)),
    );
    expect(response.status).toBe(503);
  });
});

describeIfDb('an expired sign-in attempt', () => {
  it('cannot be finished', async () => {
    stubTelegram();
    const { state } = await startLogin(db, provider, {
      redirectUri: `${WEB}/api/auth/telegram/callback`,
      now: new Date(Date.now() - 11 * 60 * 1000),
    });
    await expect(
      finishLogin(db, provider, { state, code: 'c', redirectUri: `${WEB}/api/auth/telegram/callback` }),
    ).rejects.toMatchObject({ code: 'expired' });
  });
});

describeIfDb('signing out', () => {
  it('deletes the session, from the website only', async () => {
    const user = await userForTelegram(db, { id: REVIEWER_ID });
    const { token } = await createSession(db, { userId: user!.id });
    const logout = (origin: string) =>
      withEnv(env, () =>
        logoutRoute(new Request(`${WEB}/api/auth/logout`, { method: 'POST', headers: { cookie: `__Host-session=${token}`, origin } })),
      );

    expect((await logout('https://evil.example')).status).toBe(403);
    expect(await userForSession(db, token)).not.toBeNull();

    const response = await logout(WEB);
    expect(response.headers.get('location')).toBe(`${WEB}/login`);
    expect(cookiesOf(response)['__Host-session']).toBe('');
    expect(await userForSession(db, token)).toBeNull();
  });

  it('happens by itself when the session runs out', async () => {
    const user = await userForTelegram(db, { id: REVIEWER_ID });
    const { token } = await createSession(db, { userId: user!.id, now: new Date(Date.now() - SESSION_TTL_MS - 1000) });
    expect(await userForSession(db, token)).toBeNull();
    expect(await db.select().from(userSessions)).toHaveLength(1);
  });
});

describeIfDb('who may review what', () => {
  it('makes a workspace’s reviewer a member of every workspace naming them, on any way in', async () => {
    await db.insert(workspaces).values({ id: 2, name: 'second', telegramChatId: '-1002', telegramAdminChatId: String(REVIEWER_ID) });

    const user = await userForTelegram(db, { id: REVIEWER_ID, name: 'Vita' });
    const members = await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, user!.id));
    expect(members.map((member) => member.workspaceId).sort()).toEqual([1, 2]);

    // The same person through a Mini App is the same user.
    expect((await userForTelegram(db, { id: REVIEWER_ID }))!.id).toBe(user!.id);
  });

  it('lets a Mini App in through the same rule', async () => {
    const response = await withEnv(env, () =>
      queueRoute(
        new Request('https://mini.example.com/api/telegram/webapp/queue', {
          headers: { authorization: `tma ${initDataFor(REVIEWER_ID)}` },
        }),
      ),
    );
    expect(response.status).toBe(200);

    const stranger = await withEnv(env, () =>
      queueRoute(
        new Request('https://mini.example.com/api/telegram/webapp/queue', {
          headers: { authorization: `tma ${initDataFor(STRANGER_ID)}` },
        }),
      ),
    );
    expect(stranger.status).toBe(401);
  });

  it('creates one user when two first sign-ins race', async () => {
    const [a, b] = await Promise.all([
      userForTelegram(db, { id: REVIEWER_ID }),
      userForTelegram(db, { id: REVIEWER_ID }),
    ]);
    expect(a!.id).toBe(b!.id);
    expect(await db.select().from(users)).toHaveLength(1);
  });
});
