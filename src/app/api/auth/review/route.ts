import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { reviewAccess, reviewAccessUser, reviewCredentialsMatch } from '@/lib/accounts/review-access';
import { createSession, SESSION_COOKIE } from '@/lib/accounts/sessions';
import { sameOrigin } from '@/lib/accounts/viewer';
import { loginPageUrl, redirectTo, safeReturnTo } from '@/lib/accounts/web';

/**
 * POST /api/auth/review — the reviewers' sign-in form (src/lib/accounts/review-access.ts).
 *
 * Only from the website's own page, and only with the configured username and
 * password; a wrong guess waits a second before it is answered.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FAILURE_DELAY_MS = 1_000;

export async function POST(request: Request): Promise<Response> {
  const logger = createLogger({ app: 'content-arbitrary', surface: 'auth' });
  const env = getEnv();
  const access = reviewAccess(env);
  if (!access || !env.WEB_APP_URL) return new Response('Not found.', { status: 404 });
  if (!sameOrigin(request, env.WEB_APP_URL)) return new Response('Forbidden.', { status: 403 });

  const form = await request.formData().catch(() => null);
  const username = String(form?.get('username') ?? '');
  const password = String(form?.get('password') ?? '');
  const returnTo = safeReturnTo(String(form?.get('returnTo') ?? '')) ?? '/queue';

  if (!reviewCredentialsMatch(access, username, password)) {
    logger.warn('auth.review_login_failed', {});
    await new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
    return redirectTo(`${loginPageUrl(env.WEB_APP_URL, 'review-failed')}&review=1`);
  }

  const db = getDb();
  const user = await reviewAccessUser(db, access);
  if (!user) {
    logger.error('auth.review_workspace_missing', { workspaceId: access.workspaceId });
    return redirectTo(loginPageUrl(env.WEB_APP_URL, 'failed'));
  }
  const session = await createSession(db, { userId: user.id, userAgent: request.headers.get('user-agent') });
  logger.info('auth.signed_in', { userId: user.id, provider: 'review' });
  return redirectTo(`${env.WEB_APP_URL}${returnTo}`, { set: [{ name: SESSION_COOKIE, value: session.token, expiresAt: session.expiresAt }] });
}
