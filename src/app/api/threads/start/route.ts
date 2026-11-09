import { describeError } from '@/lib/errors';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { viewerFromRequest } from '@/lib/accounts/viewer';
import { loginPageUrl, redirectTo } from '@/lib/accounts/web';
import { CONNECT_ATTEMPT_TTL_MS, startThreadsConnect } from '@/lib/threads/accounts';
import { threadsApp, threadsSettingsUrl } from '@/lib/threads/config';
import { THREADS_STATE_COOKIE } from '@/lib/threads/web';

/**
 * GET /api/threads/start?workspaceId=… — "Connect Threads" on the website's
 * settings page.
 *
 * Only on the website, signed in: the browser that starts a connection is
 * the one that must finish it, which is what the state cookie checks, and a
 * Mini App's request is not a browser that can carry it to Meta and back.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const logger = createLogger({ app: 'content-arbitrary', surface: 'threads' });
  const env = getEnv();
  const app = threadsApp(env);
  if (!app || !env.WEB_APP_URL) return new Response('Threads is not configured.', { status: 503 });

  const db = getDb();
  const viewer = await viewerFromRequest(request, { db, env });
  if (!viewer.ok || viewer.viewer.via !== 'website') {
    return redirectTo(`${loginPageUrl(env.WEB_APP_URL)}?returnTo=${encodeURIComponent('/settings')}`);
  }

  const workspaceId = Number(new URL(request.url).searchParams.get('workspaceId'));
  if (!viewer.viewer.workspaces.some((workspace) => workspace.id === workspaceId)) {
    return redirectTo(threadsSettingsUrl(env.WEB_APP_URL, 'failed'));
  }

  try {
    const { url, state } = await startThreadsConnect(db, app, { workspaceId, userId: viewer.viewer.user.id });
    logger.info('threads.connect_started', { workspaceId, userId: viewer.viewer.user.id });
    return redirectTo(url, {
      set: [{ name: THREADS_STATE_COOKIE, value: state, expiresAt: new Date(Date.now() + CONNECT_ATTEMPT_TTL_MS) }],
    });
  } catch (error) {
    logger.error('threads.connect_start_failed', { error: describeError(error) });
    return redirectTo(threadsSettingsUrl(env.WEB_APP_URL, 'failed'));
  }
}
