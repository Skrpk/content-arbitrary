/**
 * How well Shadow Radar's scores match the editor's decisions.
 *
 *   npm run radar:report -- --workspace 2
 *   npm run radar:report -- --workspace 2 --compare radar-v1,radar-v2-history-retrieval
 *
 * --compare puts two prompt versions side by side on exactly the posts both
 * scored, after the usual per-setup sections.
 */
import 'dotenv/config';
import { getDb, getSql } from '../src/lib/db';
import { formatPromptComparison, formatRadarReport, loadReportRows } from '../src/lib/radar/report';

async function main() {
  const index = process.argv.indexOf('--workspace');
  const workspaceId = Number(index === -1 ? NaN : process.argv[index + 1]);
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) {
    throw new Error('Pass the workspace: --workspace <id>');
  }

  const compareIndex = process.argv.indexOf('--compare');
  const compare = compareIndex === -1 ? undefined : process.argv[compareIndex + 1]?.split(',').map((v) => v.trim());
  if (compare && compare.length !== 2) {
    throw new Error('Pass two prompt versions: --compare radar-v1,radar-v2-history-retrieval');
  }

  const rows = await loadReportRows(getDb(), workspaceId);
  console.log(formatRadarReport(rows));
  if (compare) console.log(`\n${formatPromptComparison(rows, compare as [string, string])}`);
  await getSql().end();
}

main().catch(async (error) => {
  console.error('Radar report failed:', error instanceof Error ? error.message : error);
  await getSql().end().catch(() => {});
  process.exit(1);
});
