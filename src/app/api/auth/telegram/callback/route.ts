import { timingSafeEqual } from 'node:crypto';
import { describeError } from '@/lib/errors';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { finishLogin, LoginError } from '@/lib/accounts/oidc';
import { createSession, readCookie, SESSION_COOKIE } from '@/lib/accounts/sessions';
import { telegramAccountFromClaims, telegramLoginProvider } from '@/lib/accounts/telegram';
import { userForTelegram } from '@/lib/accounts/users';
import { LOGIN_STATE_COOKIE, loginPageUrl, redirectTo, telegramCallbackUrl } from '@/lib/accounts/web';

/**
 * GET /api/auth/telegram/callback — where Telegram sends the browser back.
 *
 * The sign-in counts only if this browser started it (the `state` in its
 * cookie matches), the code exchanges for an ID token Telegram signed for
 * this bot, and the Telegram account in it reviews some workspace. Then the
 * browser gets a session, and goes where it meant to.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const logger = createLogger({ app: 'content-arbitrary', surface: 'auth' });
  const env = getEnv();
  const provider = telegramLoginProvider(env);
  if (!env.WEB_APP_URL || !provider) {
    return new Response('Telegram sign-in is not configured.', { status: 503 });
  }
  const webAppUrl = env.WEB_APP_URL;
  const fail = (error: Parameters<typeof loginPageUrl>[1]) =>
    redirectTo(loginPageUrl(webAppUrl, error), { clear: [LOGIN_STATE_COOKIE] });

  const params = new URL(request.url).searchParams;
  if (params.get('error')) {
    logger.info('auth.denied', { error: params.get('error')?.slice(0, 100) });
    return fail('denied');
  }

  const state = params.get('state');
  const code = params.get('code');
  const expected = readCookie(request.headers.get('cookie'), LOGIN_STATE_COOKIE);
  if (!state || !code || !expected || !equal(state, expected)) {
    logger.warn('auth.state_mismatch', { hasState: Boolean(state), hasCookie: Boolean(expected) });
    return fail('expired');
  }

  const db = getDb();
  try {
    const { claims, returnTo } = await finishLogin(db, provider, {
      state,
      code,
      redirectUri: telegramCallbackUrl(webAppUrl),
    });
    const account = telegramAccountFromClaims(claims);
    const user = await userForTelegram(db, account, { recordLogin: true });
    if (!user) {
      logger.warn('auth.not_a_reviewer', {});
      return fail('not-a-reviewer');
    }

    const session = await createSession(db, { userId: user.id, userAgent: request.headers.get('user-agent') });
    logger.info('auth.signed_in', { userId: user.id, provider: 'telegram' });
    return redirectTo(`${webAppUrl}${returnTo ?? '/'}`, {
      set: [{ name: SESSION_COOKIE, value: session.token, expiresAt: session.expiresAt }],
      clear: [LOGIN_STATE_COOKIE],
    });
  } catch (error) {
    logger.error('auth.callback_failed', { error: describeError(error) });
    return fail(error instanceof LoginError ? error.code : 'failed');
  }
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
