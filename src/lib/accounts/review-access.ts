import { createHash, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { workspaceMembers, workspaces, type User } from '@/db/schema';
import type { Database } from '@/lib/db';
import type { Env } from '@/lib/env';
import { createUserWithIdentity, findUserByIdentity } from '@/lib/accounts/users';

/**
 * A way in for an app store's reviewers.
 *
 * Meta tests an app before it approves its permissions, and must be able to
 * sign in to do so — but the website's only sign-in is a Telegram account
 * that reviews some channel. So, while it is configured, the sign-in page
 * also takes one username and password from the environment, and lets in a
 * user of their own, a member of one demo workspace and of nothing else.
 * Removing the password from the environment closes it again.
 */

export interface ReviewAccess {
  username: string;
  password: string;
  workspaceId: number;
}

export function reviewAccess(
  env: Pick<Env, 'REVIEW_LOGIN_USERNAME' | 'REVIEW_LOGIN_PASSWORD' | 'REVIEW_LOGIN_WORKSPACE_ID'>,
): ReviewAccess | null {
  if (!env.REVIEW_LOGIN_PASSWORD || !env.REVIEW_LOGIN_WORKSPACE_ID) return null;
  return { username: env.REVIEW_LOGIN_USERNAME, password: env.REVIEW_LOGIN_PASSWORD, workspaceId: env.REVIEW_LOGIN_WORKSPACE_ID };
}

/** Whether the username and password are the ones configured; in constant time, whatever was typed. */
export function reviewCredentialsMatch(access: ReviewAccess, username: string, password: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const sameUser = timingSafeEqual(digest(username.trim().toLowerCase()), digest(access.username.toLowerCase()));
  const samePassword = timingSafeEqual(digest(password), digest(access.password));
  return sameUser && samePassword;
}

/** The reviewers' user, a member of the demo workspace — or null when that workspace is not there to review. */
export async function reviewAccessUser(db: Database, access: ReviewAccess): Promise<User | null> {
  const [workspace] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, access.workspaceId));
  if (!workspace) return null;
  const subject = access.username.toLowerCase();
  const user =
    (await findUserByIdentity(db, 'review', subject)) ??
    (await createUserWithIdentity(db, 'review', subject, { id: subject, name: 'App reviewer', username: subject }));
  await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: user.id, role: 'reviewer' }).onConflictDoNothing();
  return user;
}
