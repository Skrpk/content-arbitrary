import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { initDataFromAuthorizationHeader, validateInitData } from '@/lib/telegram/webapp-auth';
import type { Workspace } from '@/db/schema';
import type { Database } from '@/lib/db';
import { findWorkspacesByAdminChatId, workspaceForPost } from '@/lib/workspace';

/**
 * What every Mini App endpoint checks before touching a post, in one place so
 * the endpoints cannot drift apart on it.
 */

export const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/**
 * Resolve the request to a reviewer and the tenants they review for, or to a
 * 401.
 *
 * The request must carry `initData` signed by Telegram with a key derived from
 * our bot token, recent enough not to be a replay, naming a Telegram user who
 * is some workspace's reviewer. Which post or source they may then touch is
 * the caller's check, against the workspaces returned here.
 */
export async function authorizeReviewer(request: Request) {
  const logger = createLogger({ app: 'content-arbitrary', surface: 'webapp' });
  const env = getEnv();

  const initData = initDataFromAuthorizationHeader(request.headers.get('authorization'));
  const verdict = validateInitData(initData, env.TELEGRAM_BOT_TOKEN);

  if (!verdict.ok) {
    // The reason is logged but never returned: a caller learning *why* their
    // forgery failed is a step towards one that works.
    logger.warn('webapp.init_data_rejected', { reason: verdict.reason });
    return { ok: false as const, response: json({ error: 'unauthorized' }, 401) };
  }

  const db = getDb();
  const workspaces = await findWorkspacesByAdminChatId(db, verdict.user.id);

  if (workspaces.length === 0) {
    logger.warn('webapp.not_a_reviewer', { telegramUserId: verdict.user.id });
    return { ok: false as const, response: json({ error: 'unauthorized' }, 401) };
  }

  return {
    ok: true as const,
    db,
    env,
    workspaces,
    logger: logger.child({ telegramUserId: verdict.user.id }),
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
