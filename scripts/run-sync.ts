/**
 * Runs one synchronisation cycle from the command line.
 *
 * This is how you exercise DRY_RUN locally: `npm run sync:local`.
 * Vercel Cron cannot be triggered by `next dev`, so this script is the
 * supported way to test the pipeline before deploying.
 */
import 'dotenv/config';
import { syncPosts } from '../src/lib/sync/sync-posts';
import { getSql } from '../src/lib/db';

async function main() {
  const summary = await syncPosts();

  console.log('\n--- Sync summary ---');
  console.log(JSON.stringify(summary, null, 2));

  await getSql().end();
  process.exit(summary.error ? 1 : 0);
}

main().catch((error) => {
  console.error('Sync failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
