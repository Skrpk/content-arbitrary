/**
 * How well Shadow Radar's scores match the editor's decisions.
 *
 *   npm run radar:report -- --workspace 2
 */
import 'dotenv/config';
import { getDb, getSql } from '../src/lib/db';
import { formatRadarReport, loadReportRows } from '../src/lib/radar/report';

async function main() {
  const index = process.argv.indexOf('--workspace');
  const workspaceId = Number(index === -1 ? NaN : process.argv[index + 1]);
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) {
    throw new Error('Pass the workspace: --workspace <id>');
  }

  console.log(formatRadarReport(await loadReportRows(getDb(), workspaceId)));
  await getSql().end();
}

main().catch(async (error) => {
  console.error('Radar report failed:', error instanceof Error ? error.message : error);
  await getSql().end().catch(() => {});
  process.exit(1);
});
