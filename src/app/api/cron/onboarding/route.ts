import { authorizeCron, unauthorized } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { describeError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { runOnboarding, runnerDeps } from '@/lib/onboarding/runner';

/**
 * GET /api/cron/onboarding — run the onboarding steps that are due: a
 * channel's history read, its profile written (src/lib/onboarding/runner.ts).
 *
 * Every minute by Vercel Cron, with `Authorization: Bearer $CRON_SECRET`.
 * The webhook starts a new onboarding's first step itself; this picks up the
 * rest — the slow profiling, retries after a backoff, and any step whose
 * runner died. Most runs find nothing and cost one indexed query.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Profiling reads a hundred posts with a model: a minute or two.
export const maxDuration = 800;

/** Steps are started only while this much of the run is left for them. */
const BUDGET_MS = 700_000;

export async function GET(request: Request): Promise<Response> {
  const auth = authorizeCron(request);
  if (!auth.ok) {
    logger.warn('cron.unauthorized', { reason: auth.reason, surface: 'onboarding' });
    return unauthorized(auth.reason);
  }

  const runLogger = logger.child({ surface: 'onboarding' });
  try {
    const tally = await runOnboarding(runnerDeps(getDb(), getEnv(), runLogger), { budgetMs: BUDGET_MS });
    if (tally.ran + tally.failed + tally.retrying > 0) runLogger.info('onboarding.run', { ...tally });
    return Response.json(tally, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const message = describeError(error);
    runLogger.error('onboarding.fatal', { error: message });
    return Response.json({ error: message }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}
