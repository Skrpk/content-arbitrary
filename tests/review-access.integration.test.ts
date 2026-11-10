import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import { DEFAULT_WORKSPACE_ID, loginAttempts, users, workspaces } from '@/db/schema';
import { POST as reviewRoute } from '@/app/api/auth/review/route';
import { userForSession } from '@/lib/accounts/sessions';
import { workspacesForUser } from '@/lib/accounts/users';
import { ensureTestWorkspace, withEnv } from './helpers';

/**
 * App reviewers' way in: one username and password from the environment,
 * into one demo workspace and nothing else, from the website's own page only.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

const WEB = 'https://app.example.com';
const DEMO_WORKSPACE = 7;
const PASSWORD = 'correct-horse-battery-staple-42';

const env = {
  DATABASE_URL: connectionString,
  WEB_APP_URL: WEB,
  REVIEW_LOGIN_USERNAME: 'meta-reviewer',
  REVIEW_LOGIN_PASSWORD: PASSWORD,
  REVIEW_LOGIN_WORKSPACE_ID: String(DEMO_WORKSPACE),
};

function signIn(fields: Record<string, string>, options: { origin?: string; env?: Record<string, string | undefined> } = {}) {
  return withEnv({ ...env, ...options.env }, () =>
    reviewRoute(
      new Request(`${WEB}/api/auth/review`, {
        method: 'POST',
        headers: { origin: options.origin ?? WEB },
        body: new URLSearchParams(fields),
      }),
    ),
  );
}

function sessionOf(response: Response): string | null {
  const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith('__Host-session='));
  return header ? header.split(';')[0]!.split('=')[1]! : null;
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
  await db.delete(loginAttempts);
  await db.delete(users);
  await ensureTestWorkspace(db);
  await db.update(workspaces).set({ telegramChatId: '-1001000000001', telegramAdminChatId: '555001' }).where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
  await db.insert(workspaces).values({ id: DEMO_WORKSPACE, name: 'Zmistik demo', telegramChatId: '-1001000000007', telegramAdminChatId: '555001' });
});

describeIfDb('the app reviewers’ sign-in', () => {
  it('lets the configured username and password into the demo channel, and that one only', async () => {
    const response = await signIn({ username: 'Meta-Reviewer', password: PASSWORD, returnTo: '/settings' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${WEB}/settings`);
    const user = await userForSession(db, sessionOf(response)!);
    expect(user).not.toBeNull();
    expect((await workspacesForUser(db, user!.id)).map((workspace) => workspace.id)).toEqual([DEMO_WORKSPACE]);

    // Again: the same user, still in the demo channel alone.
    const again = await signIn({ username: 'meta-reviewer', password: PASSWORD });
    expect((await userForSession(db, sessionOf(again)!))!.id).toBe(user!.id);
  });

  it('turns away a wrong password, with no session', async () => {
    const response = await signIn({ username: 'meta-reviewer', password: `${PASSWORD}x` });
    expect(response.headers.get('location')).toBe(`${WEB}/login?error=review-failed&review=1`);
    expect(sessionOf(response)).toBeNull();
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it('is refused from another site, and is not there at all unless configured', async () => {
    expect((await signIn({ username: 'meta-reviewer', password: PASSWORD }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await signIn({ username: 'meta-reviewer', password: PASSWORD }, { env: { REVIEW_LOGIN_PASSWORD: undefined } })).status).toBe(404);
  });
});
