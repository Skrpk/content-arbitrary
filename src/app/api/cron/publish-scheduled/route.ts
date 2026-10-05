import { authorizeCron, unauthorized } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { describeError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { TelegramClient } from '@/lib/telegram/client';
import { publishDueScheduledPosts } from '@/lib/sync/publish-scheduled';

/**
 * GET /api/cron/publish-scheduled — publish scheduled posts that are due.
 *
 * Invoked every minute by Vercel Cron (see vercel.json), with the same
 * `Authorization: Bearer $CRON_SECRET` as the sync. Most runs find nothing
 * due and cost one indexed query.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const auth = authorizeCron(request);
  if (!auth.ok) {
    logger.warn('cron.unauthorized', { reason: auth.reason, surface: 'scheduled' });
    return unauthorized(auth.reason);
  }

  const runLogger = logger.child({ surface: 'scheduled' });

  try {
    const summary = await publishDueScheduledPosts({
      db: getDb(),
      env: getEnv(),
      client: new TelegramClient({ logger: runLogger }),
      logger: runLogger,
    });

    if (summary.due > 0) runLogger.info('scheduled.run', { ...summary });

    return Response.json(summary, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const message = describeError(error);
    runLogger.error('scheduled.fatal', { error: message });
    return Response.json({ error: message }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}
