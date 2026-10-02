import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { initDataFromAuthorizationHeader, validateInitData } from '@/lib/telegram/webapp-auth';
import { findWorkspaceByAdminChatId } from '@/lib/workspace';

/**
 * What every Mini App endpoint checks before touching a post, in one place so
 * the endpoints cannot drift apart on it.
 */

export const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/**
 * Resolve the request to a reviewer and their tenant, or to a 401.
 *
 * The request must carry `initData` signed by Telegram with a key derived from
 * our bot token, recent enough not to be a replay, naming a Telegram user who
 * is some workspace's reviewer. Which post they may then touch is the caller's
 * check, scoped to the workspace returned here.
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
  const workspace = await findWorkspaceByAdminChatId(db, verdict.user.id);

  if (!workspace) {
    logger.warn('webapp.not_a_reviewer', { telegramUserId: verdict.user.id });
    return { ok: false as const, response: json({ error: 'unauthorized' }, 401) };
  }

  return {
    ok: true as const,
    db,
    env,
    workspace,
    logger: logger.child({ workspaceId: workspace.id, telegramUserId: verdict.user.id }),
  };
}
