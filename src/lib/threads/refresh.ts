import { and, asc, eq, gt, lt } from 'drizzle-orm';
import { threadsAccounts } from '@/db/schema';
import type { Database } from '@/lib/db';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { refreshLongLived, type ThreadsCallOptions } from '@/lib/threads/client';
import type { ThreadsApp } from '@/lib/threads/config';
import { decryptToken, encryptToken } from '@/lib/threads/token-crypto';

/**
 * Keeping connected accounts connected. A long-lived token lasts 60 days and
 * can be refreshed once it is a day old; each one is refreshed after a week,
 * so a few failed tries in a row still leave weeks to spare. A token that ran
 * out cannot be refreshed: the account is connected again.
 *
 * Run with each sync; most runs find nothing due.
 */

export const THREADS_REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const PER_RUN = 20;

export async function refreshThreadsTokens(
  db: Database,
  app: ThreadsApp,
  options: { logger: Logger; now?: Date } & ThreadsCallOptions,
): Promise<{ refreshed: number; failed: number }> {
  const now = options.now ?? new Date();
  const due = await db
    .select()
    .from(threadsAccounts)
    .where(
      and(
        lt(threadsAccounts.tokenRefreshedAt, new Date(now.getTime() - THREADS_REFRESH_AFTER_MS)),
        gt(threadsAccounts.tokenExpiresAt, now),
      ),
    )
    .orderBy(asc(threadsAccounts.tokenRefreshedAt))
    .limit(PER_RUN);

  let refreshed = 0;
  let failed = 0;
  for (const account of due) {
    try {
      const token = await refreshLongLived(decryptToken(account.accessTokenEncrypted, app.appSecret), options);
      await db
        .update(threadsAccounts)
        .set({
          accessTokenEncrypted: encryptToken(token.accessToken, app.appSecret),
          tokenExpiresAt: new Date(now.getTime() + token.expiresIn * 1000),
          tokenRefreshedAt: now,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(threadsAccounts.id, account.id));
      refreshed += 1;
    } catch (error) {
      const message = describeError(error).slice(0, 300);
      // Tried again next run: refreshedAt stays where it was.
      await db.update(threadsAccounts).set({ lastError: message, updatedAt: now }).where(eq(threadsAccounts.id, account.id));
      options.logger.warn('threads.refresh_failed', { workspaceId: account.workspaceId, error: message });
      failed += 1;
    }
  }
  if (refreshed > 0) options.logger.info('threads.tokens_refreshed', { refreshed });
  return { refreshed, failed };
}
