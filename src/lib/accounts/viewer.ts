import type { User, Workspace } from '@/db/schema';
import type { Database } from '@/lib/db';
import type { Env } from '@/lib/env';
import { readCookie, SESSION_COOKIE, userForSession } from '@/lib/accounts/sessions';
import { userForTelegram, workspacesForUser } from '@/lib/accounts/users';
import { initDataFromAuthorizationHeader, validateInitData } from '@/lib/telegram/webapp-auth';

/**
 * Who is asking, for every endpoint the website and the Mini Apps share —
 * the one place either kind of proof is checked, so the endpoints behind it
 * cannot tell, or care, which they came through.
 *
 *  - A Mini App sends `Authorization: tma <initData>`, signed by Telegram.
 *  - The website sends its session cookie. A browser attaches cookies to a
 *    request another site makes it send, so a change — anything but GET —
 *    must also come from the website's own origin.
 */

export interface Viewer {
  user: User;
  /** What they may review: the workspaces they are a member of. */
  workspaces: Workspace[];
  via: 'mini-app' | 'website';
}

export type ViewerResult =
  | { ok: true; viewer: Viewer }
  | { ok: false; reason: 'no-credentials' | 'bad-init-data' | 'unknown-user' | 'bad-session' | 'cross-origin' | 'no-workspaces' };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function viewerFromRequest(
  request: Request,
  context: { db: Database; env: Pick<Env, 'TELEGRAM_BOT_TOKEN' | 'WEB_APP_URL'> },
): Promise<ViewerResult> {
  const { db, env } = context;
  const authorization = request.headers.get('authorization');

  let user: User | null;
  let via: Viewer['via'];

  if (authorization) {
    const verdict = validateInitData(initDataFromAuthorizationHeader(authorization), env.TELEGRAM_BOT_TOKEN);
    if (!verdict.ok) return { ok: false, reason: 'bad-init-data' };
    user = await userForTelegram(db, { id: verdict.user.id, name: verdict.user.firstName, username: verdict.user.username });
    if (!user) return { ok: false, reason: 'unknown-user' };
    via = 'mini-app';
  } else {
    const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
    if (!token) return { ok: false, reason: 'no-credentials' };
    if (!SAFE_METHODS.has(request.method.toUpperCase()) && !sameOrigin(request, env.WEB_APP_URL)) {
      return { ok: false, reason: 'cross-origin' };
    }
    user = await userForSession(db, token);
    if (!user) return { ok: false, reason: 'bad-session' };
    via = 'website';
  }

  const workspaces = await workspacesForUser(db, user.id);
  if (workspaces.length === 0) return { ok: false, reason: 'no-workspaces' };
  return { ok: true, viewer: { user, workspaces, via } };
}

/**
 * Whether a request says it comes from the website itself. Browsers send
 * `Origin` on every request that can change something, and a page cannot
 * forge it.
 */
export function sameOrigin(request: Request, webAppUrl: string | undefined): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const url = new URL(request.url);
  // The Host the browser sent: a page elsewhere cannot set it, and it is the
  // website's own host even where the runtime rewrites the request URL's.
  const host = request.headers.get('host');
  const allowed = [webAppUrl, url.origin, host ? `${url.protocol}//${host}` : null].filter(Boolean);
  return allowed.includes(origin);
}
