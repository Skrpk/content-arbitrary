import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import { userSessions, users, type User } from '@/db/schema';
import type { Database } from '@/lib/db';

/**
 * Website sessions: a random token in an httpOnly cookie, its SHA-256 in the
 * database. The browser never holds anything it could decode or forge, and
 * deleting the row signs it out wherever it is.
 */

/** How long a sign-in lasts. Using the site does not extend it: after this, sign in again. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** How stale `last_seen_at` may be before a request refreshes it — not a write per request. */
const LAST_SEEN_GRANULARITY_MS = 10 * 60 * 1000;

/**
 * `__Host-`: the browser takes it only over HTTPS, for this exact host and
 * path `/`, so no other subdomain can set or read it.
 */
export const SESSION_COOKIE = '__Host-session';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 32 random bytes, URL-safe: a session token, a login `state`, a PKCE verifier. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function createSession(
  db: Database,
  input: { userId: number; userAgent?: string | null; now?: Date },
): Promise<{ token: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  // Their sessions that have run out go as a new one starts; nothing else needs them.
  await db.delete(userSessions).where(and(eq(userSessions.userId, input.userId), lt(userSessions.expiresAt, now)));
  await db.insert(userSessions).values({
    userId: input.userId,
    tokenHash: hashToken(token),
    expiresAt,
    lastSeenAt: now,
    userAgent: input.userAgent?.slice(0, 300) ?? null,
  });
  return { token, expiresAt };
}

/** The signed-in user for a session token, or null for one unknown or expired. */
export async function userForSession(db: Database, token: string | null, now = new Date()): Promise<User | null> {
  if (!token) return null;
  const rows = await db
    .select({ id: userSessions.id, lastSeenAt: userSessions.lastSeenAt, user: users })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .where(and(eq(userSessions.tokenHash, hashToken(token)), gt(userSessions.expiresAt, now)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  if (now.getTime() - row.lastSeenAt.getTime() > LAST_SEEN_GRANULARITY_MS) {
    await db.update(userSessions).set({ lastSeenAt: now }).where(eq(userSessions.id, row.id));
  }
  return row.user;
}

export async function deleteSession(db: Database, token: string | null): Promise<void> {
  if (!token) return;
  await db.delete(userSessions).where(eq(userSessions.tokenHash, hashToken(token)));
}

/** A `Set-Cookie` value: httpOnly, HTTPS only, this host only, sent on top-level navigations from elsewhere. */
export function cookieHeader(name: string, value: string, expiresAt: Date): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expiresAt.toUTCString()}`;
}

/** A `Set-Cookie` value that removes the cookie. */
export function clearedCookieHeader(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** One cookie's value from a `Cookie` header, or null. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim() || null;
  }
  return null;
}
