import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { viewerFromRequest } from '@/lib/accounts/viewer';
import type { Workspace } from '@/db/schema';
import type { Database } from '@/lib/db';
import { workspaceForPost } from '@/lib/workspace';

/**
 * What every Mini App and website endpoint checks before touching a post, in
 * one place so the endpoints cannot drift apart on it.
 */

export const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/**
 * Resolve the request to a reviewer and the workspaces they review for, or to
 * a 401.
 *
 * Either proof will do — a Mini App's `initData`, signed by Telegram with a
 * key derived from our bot token and recent enough not to be a replay, or the
 * website's session cookie on a request from the website itself — naming a
 * user who is a member of some workspace. Which post or source they may then
 * touch is the caller's check, against the workspaces returned here.
 */
export async function authorizeReviewer(request: Request) {
  const logger = createLogger({ app: 'content-arbitrary', surface: 'webapp' });
  const env = getEnv();
  const db = getDb();

  const result = await viewerFromRequest(request, { db, env });
  if (!result.ok) {
    // The reason is logged but never returned: a caller learning *why* their
    // forgery failed is a step towards one that works.
    logger.warn('webapp.unauthorized', { reason: result.reason });
    // A change from another site is refused as such: whoever is signed in
    // stays signed in, and the page is not sent to sign in again.
    return result.reason === 'cross-origin'
      ? { ok: false as const, response: json({ error: 'forbidden' }, 403) }
      : { ok: false as const, response: json({ error: 'unauthorized' }, 401) };
  }

  const { viewer } = result;
  return {
    ok: true as const,
    db,
    env,
    user: viewer.user,
    workspaces: viewer.workspaces,
    via: viewer.via,
    logger: logger.child({ userId: viewer.user.id, via: viewer.via }),
  };
}

/**
 * The reviewer's workspace a post belongs to, or null — for a post of a
 * tenant they do not review for exactly as for one that does not exist.
 */
export function reviewerWorkspaceForPost(
  auth: { db: Database; workspaces: Workspace[] },
  postId: number,
): Promise<Workspace | null> {
  return workspaceForPost(auth.db, auth.workspaces, postId);
}
