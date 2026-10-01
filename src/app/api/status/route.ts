import { authorizeAdmin, unauthorized } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getEnv, redactedEnvSummary } from '@/lib/env';
import { describeError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { getRecentPosts, getStatusCounts, getSyncState } from '@/lib/sync/repository';
import { listSources, syncStateKey } from '@/lib/sources/repository';
import { destinationFor, listAllWorkspaces } from '@/lib/workspace';

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
    const [tenants, counts, recent] = await Promise.all([
      listAllWorkspaces(db),
      getStatusCounts(db),
      getRecentPosts(db, 10),
    ]);

    /**
     * Reported per tenant, because sources are scoped to one: a flat list would
     * silently show only the first workspace's accounts and read as if the
     * others had none.
     */
    const workspaceStates = await Promise.all(
      tenants.map(async (tenant) => {
        const tenantSources = await listSources(db, tenant.id);

        // Each source keeps its own cursor, so report them side by side.
        const sourceStates = await Promise.all(
          tenantSources.map(async (source) => {
            const state = await getSyncState(db, syncStateKey(source), source.workspaceId);
            return {
              username: source.username,
              platform: source.platform,
              externalId: source.externalId,
              enabled: source.enabled,
              lastSyncAt: state?.lastSyncAt ?? null,
              lastSuccessfulSyncAt: state?.lastSuccessfulSyncAt ?? null,
              lastSeenPostId: state?.lastSeenPostId ?? null,
              lastError: state?.lastError ?? null,
            };
          }),
        );

        const publishable = destinationFor(tenant, env);

        return {
          workspaceId: tenant.id,
          name: tenant.name,
          // Chat ids are configuration, not secrets, and knowing where a tenant
          // publishes is the point of this endpoint.
          telegramChatId: tenant.telegramChatId,
          hasReviewer: Boolean(tenant.telegramAdminChatId),
          publishable: publishable.ok,
          ...(publishable.ok ? {} : { unpublishableReason: publishable.reason }),
          sources: sourceStates,
        };
      }),
    );

    // Kept for anything already reading a flat list of this install's sources.
    const sourceStates = workspaceStates.flatMap((tenant) => tenant.sources);

    return Response.json(
      {
        ok: true,
        config: redactedEnvSummary(env),
        workspaces: workspaceStates,
        sources: sourceStates,
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
          adminMessageId: post.adminMessageId,
          reviewedAt: post.reviewedAt,
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
