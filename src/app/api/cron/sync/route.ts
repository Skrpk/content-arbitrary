import { authorizeCron, unauthorized } from '@/lib/auth';
import { describeError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { syncPosts } from '@/lib/sync/sync-posts';

/**
 * GET /api/cron/sync — one synchronisation cycle.
 *
 * Invoked hourly by Vercel Cron (see vercel.json). Vercel sends
 * `Authorization: Bearer $CRON_SECRET` automatically once CRON_SECRET is set as
 * a project environment variable.
 */

// Node runtime: we need the postgres driver, Buffer and FormData file uploads,
// none of which are available on the Edge runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const auth = authorizeCron(request);
  if (!auth.ok) {
    logger.warn('cron.unauthorized', { reason: auth.reason });
    return unauthorized(auth.reason);
  }

  try {
    const summary = await syncPosts();

    return Response.json(
      {
        checked: summary.checked,
        newPosts: summary.newPosts,
        published: summary.published,
        failed: summary.failed,
        skipped: summary.skipped,
        dryRun: summary.dryRun,
        durationMs: summary.durationMs,
        runId: summary.runId,
        ...(summary.lockBusy ? { lockBusy: true } : {}),
        ...(summary.error ? { error: summary.error } : {}),
      },
      {
        // A sync that hit a fatal error still returns its counts, but with a
        // 500 so the failure is visible in the Vercel cron log.
        status: summary.error ? 500 : 200,
        headers: { 'cache-control': 'no-store' },
      },
    );
  } catch (error) {
    // Reached only on a configuration error (invalid env, unreachable database).
    const message = describeError(error);
    logger.error('cron.fatal', { error: message });
    return Response.json(
      { checked: 0, newPosts: 0, published: 0, failed: 0, skipped: 0, error: message },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    );
  }
}
