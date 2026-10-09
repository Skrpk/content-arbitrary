import { cookies } from 'next/headers';
import type { User, Workspace } from '@/db/schema';
import { getDb } from '@/lib/db';
import { SESSION_COOKIE, userForSession } from '@/lib/accounts/sessions';
import { workspacesForUser } from '@/lib/accounts/users';

/**
 * The person signed in to the website, for its pages — the same session
 * check the API makes, read from the cookie as the page renders. Null for
 * nobody, an expired session, or someone who reviews nothing.
 */
export async function currentWebViewer(): Promise<{ user: User; workspaces: Workspace[] } | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  if (!token) return null;
  const db = getDb();
  const user = await userForSession(db, token);
  if (!user) return null;
  const workspaces = await workspacesForUser(db, user.id);
  return workspaces.length > 0 ? { user, workspaces } : null;
}
