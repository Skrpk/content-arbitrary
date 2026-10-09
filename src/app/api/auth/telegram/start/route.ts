import { describeError } from '@/lib/errors';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { LOGIN_ATTEMPT_TTL_MS, startLogin } from '@/lib/accounts/oidc';
import { telegramLoginProvider } from '@/lib/accounts/telegram';
import { LOGIN_STATE_COOKIE, redirectTo, safeReturnTo, telegramCallbackUrl } from '@/lib/accounts/web';

/**
 * GET /api/auth/telegram/start — "Log in with Telegram" on the website.
 *
 * Remembers a new sign-in and sends the browser to Telegram, with its `state`
 * also in a short-lived cookie, so the callback accepts only the sign-in this
 * browser started.
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

  try {
    const { url, state } = await startLogin(getDb(), provider, {
      redirectUri: telegramCallbackUrl(env.WEB_APP_URL),
      returnTo: safeReturnTo(new URL(request.url).searchParams.get('returnTo')),
    });
    return redirectTo(url, {
      set: [{ name: LOGIN_STATE_COOKIE, value: state, expiresAt: new Date(Date.now() + LOGIN_ATTEMPT_TTL_MS) }],
    });
  } catch (error) {
    logger.error('auth.start_failed', { error: describeError(error) });
    return new Response('Could not reach Telegram. Please try again.', { status: 502 });
  }
}
