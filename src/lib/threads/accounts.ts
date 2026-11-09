import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, inArray, lt } from 'drizzle-orm';
import { threadsAccounts, threadsConnectAttempts, type ThreadsAccount } from '@/db/schema';
import type { Database } from '@/lib/db';
import { workspacesForUser } from '@/lib/accounts/users';
import { exchangeCode, exchangeForLongLived, threadsMe, type ThreadsCallOptions } from '@/lib/threads/client';
import { THREADS_AUTHORIZE_URL, THREADS_SCOPES, type ThreadsApp } from '@/lib/threads/config';
import { decryptToken, encryptToken } from '@/lib/threads/token-crypto';

/**
 * Connecting a channel's Threads account, and what is kept of it.
 *
 * A reviewer signed in to the website starts it for one of their channels:
 * a `state` is remembered for ten minutes, tied to them and the channel, and
 * the browser goes to Meta's authorization window with it — and with it in a
 * cookie, so only the browser that started can finish. Back at the callback
 * the state is used up, the code becomes a long-lived token, and the token is
 * stored, encrypted, for the channel. Connecting again replaces it.
 */

export const CONNECT_ATTEMPT_TTL_MS = 10 * 60 * 1000;

export class ThreadsConnectError extends Error {
  constructor(
    message: string,
    readonly code: 'expired' | 'failed',
  ) {
    super(message);
    this.name = 'ThreadsConnectError';
  }
}

const hashState = (state: string) => createHash('sha256').update(state).digest('hex');

/** A new connection for this channel: the authorization window's address, and the state to keep in a cookie. */
export async function startThreadsConnect(
  db: Database,
  app: ThreadsApp,
  input: { workspaceId: number; userId: number; now?: Date },
): Promise<{ url: string; state: string }> {
  const now = input.now ?? new Date();
  const state = randomBytes(32).toString('base64url');
  await db.delete(threadsConnectAttempts).where(lt(threadsConnectAttempts.expiresAt, now));
  await db.insert(threadsConnectAttempts).values({
    stateHash: hashState(state),
    workspaceId: input.workspaceId,
    userId: input.userId,
    expiresAt: new Date(now.getTime() + CONNECT_ATTEMPT_TTL_MS),
  });

  const url = new URL(THREADS_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: app.appId,
    redirect_uri: app.redirectUri,
    scope: THREADS_SCOPES.join(','),
    response_type: 'code',
    state,
  }).toString();
  return { url: url.toString(), state };
}

/**
 * Finish a connection: the state must be one this user started, unused and
 * in time, for a channel they still review; then the account is stored.
 */
export async function finishThreadsConnect(
  db: Database,
  app: ThreadsApp,
  input: { state: string; code: string; userId: number; now?: Date } & ThreadsCallOptions,
): Promise<ThreadsAccount> {
  const now = input.now ?? new Date();
  // Used up whatever happens next: a code is good once, and so is its state.
  const [attempt] = await db
    .delete(threadsConnectAttempts)
    .where(and(eq(threadsConnectAttempts.stateHash, hashState(input.state)), gt(threadsConnectAttempts.expiresAt, now)))
    .returning();
  if (!attempt || attempt.userId !== input.userId) {
    throw new ThreadsConnectError('no such connection under way for this user', 'expired');
  }
  const reviews = await workspacesForUser(db, input.userId);
  if (!reviews.some((workspace) => workspace.id === attempt.workspaceId)) {
    throw new ThreadsConnectError('the user no longer reviews this channel', 'failed');
  }

  const shortLived = await exchangeCode(app, input.code, input);
  const token = await exchangeForLongLived(app, shortLived, input);
  const me = await threadsMe(token.accessToken, input);

  const values = {
    workspaceId: attempt.workspaceId,
    threadsUserId: me.id,
    username: me.username,
    accessTokenEncrypted: encryptToken(token.accessToken, app.appSecret),
    tokenExpiresAt: new Date(now.getTime() + token.expiresIn * 1000),
    tokenRefreshedAt: now,
    scopes: [...THREADS_SCOPES],
    connectedByUserId: input.userId,
    lastError: null,
    updatedAt: now,
  };
  const [account] = await db
    .insert(threadsAccounts)
    .values({ ...values, createdAt: now })
    .onConflictDoUpdate({ target: threadsAccounts.workspaceId, set: { ...values, createdAt: now } })
    .returning();
  return account!;
}

/** The connected accounts of these channels. */
export function threadsAccountsFor(db: Database, workspaceIds: number[]): Promise<ThreadsAccount[]> {
  if (workspaceIds.length === 0) return Promise.resolve([]);
  return db.select().from(threadsAccounts).where(inArray(threadsAccounts.workspaceId, workspaceIds));
}

/** Disconnect a channel's account; whether there was one. */
export async function disconnectThreads(db: Database, workspaceId: number): Promise<boolean> {
  const deleted = await db.delete(threadsAccounts).where(eq(threadsAccounts.workspaceId, workspaceId)).returning({ id: threadsAccounts.id });
  return deleted.length > 0;
}

/**
 * Forget a Threads user everywhere: what Meta asks when they remove the app
 * or ask for their data to be deleted. How many channels had them.
 */
export async function forgetThreadsUser(db: Database, threadsUserId: string): Promise<number> {
  const deleted = await db
    .delete(threadsAccounts)
    .where(eq(threadsAccounts.threadsUserId, threadsUserId))
    .returning({ id: threadsAccounts.id });
  return deleted.length;
}

/** The account's token, to call Threads with. */
export function threadsAccessToken(account: Pick<ThreadsAccount, 'accessTokenEncrypted'>, app: Pick<ThreadsApp, 'appSecret'>): string {
  return decryptToken(account.accessTokenEncrypted, app.appSecret);
}

export type ThreadsAccountStatus = 'active' | 'expired' | 'refresh_failed';

export function threadsAccountStatus(account: Pick<ThreadsAccount, 'tokenExpiresAt' | 'lastError'>, now = new Date()): ThreadsAccountStatus {
  if (account.tokenExpiresAt.getTime() <= now.getTime()) return 'expired';
  return account.lastError ? 'refresh_failed' : 'active';
}
