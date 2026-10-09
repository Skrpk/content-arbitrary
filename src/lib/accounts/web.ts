import { clearedCookieHeader, cookieHeader } from '@/lib/accounts/sessions';

/**
 * The website's side of signing in: where the provider sends people back to,
 * where they may be sent on to afterwards, and the redirects in between.
 */

/** Holds a sign-in's `state` between leaving for the provider and coming back. */
export const LOGIN_STATE_COOKIE = '__Host-login-state';

/** The callback registered with Telegram, under BotFather's Login Widget. */
export function telegramCallbackUrl(webAppUrl: string): string {
  return `${webAppUrl}/api/auth/telegram/callback`;
}

/**
 * A path on the website to land on after signing in, or null. Only a plain
 * path will do: anything that could name another site — `//evil.example`,
 * `/\evil.example`, a scheme — is refused, so the sign-in cannot be used to
 * bounce someone elsewhere.
 */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value || value.length > 300) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  if (/[\u0000-\u001f\\]/.test(value)) return null;
  return value;
}

/** A redirect, setting and clearing cookies on the way. */
export function redirectTo(
  location: string,
  cookies: { set?: { name: string; value: string; expiresAt: Date }[]; clear?: string[] } = {},
): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const cookie of cookies.set ?? []) headers.append('set-cookie', cookieHeader(cookie.name, cookie.value, cookie.expiresAt));
  for (const name of cookies.clear ?? []) headers.append('set-cookie', clearedCookieHeader(name));
  return new Response(null, { status: 303, headers });
}

/** The sign-in page, saying what went wrong. */
export function loginPageUrl(webAppUrl: string, error?: 'denied' | 'failed' | 'expired' | 'not-a-reviewer'): string {
  return `${webAppUrl}/login${error ? `?error=${error}` : ''}`;
}
