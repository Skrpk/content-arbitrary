import { describeError } from '@/lib/errors';
import { loadSourceStats, periodStart, STATS_PERIODS, type StatsPeriod, X_POST_READ_USD } from '@/lib/sources/stats';
import { REJECTION_REASON_LABELS } from '@/lib/sync/approval';
import { authorizeReviewer, json } from '@/lib/telegram/webapp-request';

/**
 * The source stats Mini App's API: per source, what it brought in over a
 * period and what the reviewer made of it.
 *
 * Guarded like the other Mini App endpoints — signed `initData` naming a
 * workspace's reviewer — and read only for the workspaces they review for.
 *
 *   GET /api/telegram/webapp/source-stats?period=7d|30d|all
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: Request): Promise<Response> {
  let auth: Awaited<ReturnType<typeof authorizeReviewer>>;
  try {
    auth = await authorizeReviewer(request);
  } catch (error) {
    return json({ error: describeError(error) }, 500);
  }
  if (!auth.ok) return auth.response;

  const requested = new URL(request.url).searchParams.get('period') ?? '7d';
  if (!(STATS_PERIODS as readonly string[]).includes(requested)) {
    return json({ error: 'bad request' }, 400);
  }
  const period = requested as StatsPeriod;

  const stats = await loadSourceStats(auth.db, {
    workspaceIds: auth.workspaces.map((workspace) => workspace.id),
    since: periodStart(period),
  });

  return json({
    period,
    postReadUsd: X_POST_READ_USD,
    reasonLabels: REJECTION_REASON_LABELS,
    channels: auth.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      sources: stats
        .filter((entry) => entry.workspaceId === workspace.id)
        .map(({ workspaceId: _workspaceId, lastPostAt, ...entry }) => ({
          ...entry,
          lastPostAt: lastPostAt?.toISOString() ?? null,
        })),
    })),
  });
}
