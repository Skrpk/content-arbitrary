import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { deleteSession, readCookie, SESSION_COOKIE } from '@/lib/accounts/sessions';
import { sameOrigin } from '@/lib/accounts/viewer';
import { loginPageUrl, redirectTo } from '@/lib/accounts/web';

/**
 * POST /api/auth/logout — the website's Sign out: the session is deleted, not
 * just forgotten by this browser. Only from the website itself, so another
 * site cannot sign someone out behind their back.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const env = getEnv();
  if (!sameOrigin(request, env.WEB_APP_URL)) return new Response('forbidden', { status: 403 });

  await deleteSession(getDb(), readCookie(request.headers.get('cookie'), SESSION_COOKIE));
  return redirectTo(env.WEB_APP_URL ? loginPageUrl(env.WEB_APP_URL) : '/', { clear: [SESSION_COOKIE] });
}
