import { authorizeAdmin, unauthorized } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getEnv, redactedEnvSummary } from '@/lib/env';
import { describeError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { getRecentPosts, getStatusCounts, getSyncState } from '@/lib/sync/repository';

/**
 * GET /api/status — operational visibility.
 *
 * Protected by ADMIN_SECRET (falling back to CRON_SECRET). The response
 * deliberately contains no secrets: configuration is reported only as
 * "is it set", never as a value.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const auth = authorizeAdmin(request);
  if (!auth.ok) {
    logger.warn('status.unauthorized', { reason: auth.reason });
    return unauthorized(auth.reason);
  }

  try {
    const env = getEnv();
    const db = getDb();
    const source = `x:${env.X_USER_ID ?? env.X_USERNAME ?? 'unknown'}`;

    const [state, counts, recent] = await Promise.all([
      getSyncState(db, source),
      getStatusCounts(db),
      getRecentPosts(db, 10),
    ]);

    return Response.json(
      {
        ok: true,
        config: redactedEnvSummary(env),
        sync: {
          source,
          lastSyncAt: state?.lastSyncAt ?? null,
          lastSuccessfulSyncAt: state?.lastSuccessfulSyncAt ?? null,
          lastSeenPostId: state?.lastSeenPostId ?? null,
          lastError: state?.lastError ?? null,
        },
        counts,
        recentPosts: recent.map((post) => ({
          xPostId: post.xPostId,
          xPostUrl: post.xPostUrl,
          status: post.status,
          telegramMessageId: post.telegramMessageId,
          telegramMethod: post.telegramMethod,
          mediaCount: post.mediaCount,
          retryCount: post.retryCount,
          errorMessage: post.errorMessage,
          processedAt: post.processedAt,
          createdAt: post.createdAt,
        })),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    const message = describeError(error);
    logger.error('status.failed', { error: message });
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
