import { authorizeCron, unauthorized } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { describeError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { TelegramClient } from '@/lib/telegram/client';
import { publishDueScheduledPosts } from '@/lib/sync/publish-scheduled';
import { runThreadsDeliveries } from '@/lib/threads/publisher';

/**
 * GET /api/cron/publish-scheduled — publish scheduled posts that are due.
 *
 * Invoked every minute by Vercel Cron (see vercel.json), with the same
 * `Authorization: Bearer $CRON_SECRET` as the sync. Most runs find nothing
 * due and cost one indexed query. Then the posts on their way to Threads,
 * a step each (src/lib/threads/publisher.ts).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Threads: media copied for it to fetch, and a short wait while it processes them.
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const auth = authorizeCron(request);
  if (!auth.ok) {
    logger.warn('cron.unauthorized', { reason: auth.reason, surface: 'scheduled' });
    return unauthorized(auth.reason);
  }

  const runLogger = logger.child({ surface: 'scheduled' });

  try {
    const db = getDb();
    const env = getEnv();
    const client = new TelegramClient({ logger: runLogger });
    const summary = await publishDueScheduledPosts({ db, env, client, logger: runLogger });
    if (summary.due > 0) runLogger.info('scheduled.run', { ...summary });

    // After the scheduled posts, so a post scheduled for Threads goes on in the same run.
    const threads = await runThreadsDeliveries({ db, env, client, logger: runLogger.child({ surface: 'threads' }) }).catch(
      (error: unknown) => {
        runLogger.error('threads.run_failed', { error: describeError(error) });
        return null;
      },
    );
    const threadsActive = threads !== null && Object.values(threads).some((count) => count > 0);
    if (threadsActive) runLogger.info('threads.run', { ...threads });

    return Response.json({ ...summary, ...(threadsActive ? { threads } : {}) }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const message = describeError(error);
    runLogger.error('scheduled.fatal', { error: message });
    return Response.json({ error: message }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}
