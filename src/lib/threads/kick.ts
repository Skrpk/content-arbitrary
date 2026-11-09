import { after } from 'next/server';
import { eq } from 'drizzle-orm';
import { postDeliveries } from '@/db/schema';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { TelegramClient } from '@/lib/telegram/client';
import { runThreadsDeliveries } from '@/lib/threads/publisher';

/**
 * Start a just-decided post on its way to Threads once the response has gone
 * — so a text post is there in seconds, not at the next minute's run. Outside
 * a request (a script, a test) there is no "after": the cron picks it up.
 */
export function publishToThreadsSoon(postId: number, logger: Logger): void {
  try {
    after(async () => {
      try {
        const db = getDb();
        const ids = (await db.select({ id: postDeliveries.id }).from(postDeliveries).where(eq(postDeliveries.processedPostId, postId))).map(
          (row) => row.id,
        );
        if (ids.length === 0) return;
        await runThreadsDeliveries({ db, env: getEnv(), client: new TelegramClient({ logger }), logger, ids });
      } catch (error) {
        logger.warn('threads.immediate_run_failed', { error: describeError(error) });
      }
    });
  } catch {
    // Not in a request: the next scheduled run publishes it.
  }
}
