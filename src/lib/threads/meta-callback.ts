import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { forgetThreadsUser } from '@/lib/threads/accounts';
import { threadsUserFromSignedRequest } from '@/lib/threads/signed-request';

/**
 * What Meta's uninstall and data deletion callbacks share: a form post whose
 * `signed_request` names a Threads user, signed with the app secret. That
 * user's accounts are forgotten on every channel — their tokens with them.
 */
export async function forgetFromMetaCallback(
  request: Request,
  event: 'deauthorized' | 'deletion_requested',
): Promise<{ ok: true; forgotten: number; appSecret: string; webAppUrl: string } | { ok: false; response: Response }> {
  const logger = createLogger({ app: 'content-arbitrary', surface: 'threads' });
  const env = getEnv();
  if (!env.THREADS_APP_SECRET || !env.WEB_APP_URL) {
    return { ok: false, response: Response.json({ error: 'not configured' }, { status: 503 }) };
  }

  const form = await request.formData().catch(() => null);
  const signed = form?.get('signed_request');
  const threadsUserId = threadsUserFromSignedRequest(typeof signed === 'string' ? signed : null, env.THREADS_APP_SECRET);
  if (!threadsUserId) {
    logger.warn('threads.callback_bad_signature', { event });
    return { ok: false, response: Response.json({ error: 'bad signed_request' }, { status: 400 }) };
  }

  const forgotten = await forgetThreadsUser(getDb(), threadsUserId);
  logger.info(`threads.${event}`, { forgotten });
  return { ok: true, forgotten, appSecret: env.THREADS_APP_SECRET, webAppUrl: env.WEB_APP_URL };
}
