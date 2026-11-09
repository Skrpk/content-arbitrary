import { timingSafeEqual } from 'node:crypto';
import { describeError } from '@/lib/errors';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { viewerFromRequest } from '@/lib/accounts/viewer';
import { readCookie } from '@/lib/accounts/sessions';
import { redirectTo } from '@/lib/accounts/web';
import { finishThreadsConnect, ThreadsConnectError } from '@/lib/threads/accounts';
import { threadsApp, threadsSettingsUrl, type ThreadsConnectOutcome } from '@/lib/threads/config';
import { THREADS_STATE_COOKIE } from '@/lib/threads/web';

/**
 * GET /api/threads/callback — where Meta's authorization window sends the
 * browser back, with a code or with an error.
 *
 * The connection counts only if this browser started it (the state in its
 * cookie matches), it is still signed in as the reviewer who did, and the
 * code exchanges for a token. Then the settings page says how it went.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const logger = createLogger({ app: 'content-arbitrary', surface: 'threads' });
  const env = getEnv();
  const app = threadsApp(env);
  if (!app || !env.WEB_APP_URL) return new Response('Threads is not configured.', { status: 503 });
  const webAppUrl = env.WEB_APP_URL;
  const done = (outcome: ThreadsConnectOutcome) => redirectTo(threadsSettingsUrl(webAppUrl, outcome), { clear: [THREADS_STATE_COOKIE] });

  const params = new URL(request.url).searchParams;
  if (params.get('error')) {
    logger.info('threads.connect_denied', { error: params.get('error')?.slice(0, 100) });
    return done('denied');
  }

  const state = params.get('state');
  // Meta appends `#_` to the redirect; a browser keeps that out of the query, but a careless copy may not.
  const code = params.get('code')?.replace(/#_$/, '');
  const expected = readCookie(request.headers.get('cookie'), THREADS_STATE_COOKIE);
  if (!state || !code || !expected || !equal(state, expected)) {
    logger.warn('threads.state_mismatch', { hasState: Boolean(state), hasCookie: Boolean(expected) });
    return done('expired');
  }

  const db = getDb();
  const viewer = await viewerFromRequest(request, { db, env });
  if (!viewer.ok || viewer.viewer.via !== 'website') {
    logger.warn('threads.callback_signed_out', {});
    return done('expired');
  }

  try {
    const account = await finishThreadsConnect(db, app, { state, code, userId: viewer.viewer.user.id });
    logger.info('threads.connected', { workspaceId: account.workspaceId, userId: viewer.viewer.user.id });
    return done('connected');
  } catch (error) {
    logger.error('threads.connect_failed', { error: describeError(error) });
    return done(error instanceof ThreadsConnectError ? error.code : 'failed');
  }
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
