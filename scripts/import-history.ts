/**
 * Import a publication's own past posts — its back catalogue — from an export
 * file into `publication_history_items`.
 *
 *   npm run history:import -- --workspace 2 --adapter telegram-json --file ./result.json [--dry-run]
 *
 * telegram-json: Telegram Desktop → the channel → ⋮ → Export chat history →
 * format "Machine-readable JSON"; pass the `result.json` it writes. Media files
 * need not be included: they are recorded as missing, not required.
 *
 * Safe to re-run, and to run again on a later export of the same channel:
 * items already stored are updated in place, never duplicated. --dry-run reads
 * and checks the file and reports what an import would do, writing nothing.
 */
import 'dotenv/config';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { eq } from 'drizzle-orm';
import { workspaces } from '../src/db/schema';
import { getDb, getSql } from '../src/lib/db';
import { createLogger } from '../src/lib/logger';
import { HISTORY_ADAPTERS, historyAdapter } from '../src/lib/history/adapters';
import {
  HISTORY_MAX_FILE_BYTES,
  importPublicationHistory,
  type HistoryImportReport,
} from '../src/lib/history/import-history';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const workspaceId = Number(argument('workspace'));
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) {
    throw new Error('Pass the workspace: --workspace <id>');
  }
  const adapterType = argument('adapter');
  const adapter = adapterType ? historyAdapter(adapterType) : undefined;
  if (!adapter) {
    const known = HISTORY_ADAPTERS.map((candidate) => candidate.type).join(', ');
    throw new Error(`Pass the export format: --adapter <${known}>`);
  }
  const path = argument('file');
  if (!path) throw new Error('Pass the export file: --file <path>');

  const { size } = await stat(path);
  if (size > HISTORY_MAX_FILE_BYTES) {
    throw new Error(
      `${path} is ${megabytes(size)}; the importer reads files up to ${megabytes(HISTORY_MAX_FILE_BYTES)}`,
    );
  }

  const db = getDb();
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new Error(`No workspace ${workspaceId}`);

  // Ctrl+C mid-import stops between batches, rolls the items back and records
  // the import as failed, rather than leaving it "processing".
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort(new Error('interrupted (Ctrl+C)')));

  const dryRun = process.argv.includes('--dry-run');
  const result = await importPublicationHistory({
    db,
    workspaceId,
    adapter,
    file: { name: basename(path), bytes: await readFile(path) },
    dryRun,
    signal: abort.signal,
    logger: createLogger({ app: 'content-arbitrary', surface: 'history-import' }),
  });

  print(result, workspace.name);
}

function print(result: HistoryImportReport, workspaceName: string) {
  const { counts, content } = result;
  const row = (label: string, value: number | string) =>
    console.log(`${`${label}:`.padEnd(16)}${typeof value === 'number' ? value.toLocaleString('en-US').padStart(9) : value}`);
  const date = (value: Date | null) => value?.toISOString().slice(0, 10) ?? '—';

  console.log(result.dryRun ? 'History import — dry run, nothing written' : 'History import completed');
  console.log('');
  row('Workspace', workspaceName);
  row('Adapter', result.adapter);
  row('Platform', result.platform);
  row('Publication', `${result.publicationName ?? '—'} (${result.publicationKey})`);
  console.log('');
  row('Messages seen', counts.seen);
  if (result.dryRun) {
    row('New', counts.imported);
    row('Already stored', counts.unchanged);
  } else {
    row('Imported', counts.imported);
    row('Updated', counts.updated);
    row('Unchanged', counts.unchanged);
  }
  row('Skipped', counts.skipped);
  row('Failed', counts.failed);
  console.log('');
  row('Text only', content.textOnly);
  row('With photo', content.withPhoto);
  row('With video', content.withVideo);
  row('Other media', content.otherMedia);
  console.log('');
  row('Date range', `${date(result.firstPublishedAt)} → ${date(result.lastPublishedAt)}`);

  for (const [label, reasons] of [
    ['Skipped', result.skippedByReason],
    ['Failed', result.failedByReason],
    ['Warnings', result.warningsByReason],
  ] as const) {
    const entries = Object.entries(reasons).sort(([, a], [, b]) => b - a);
    if (entries.length === 0) continue;
    console.log('');
    console.log(`${label}:`);
    for (const [reason, count] of entries) console.log(`  ${reason}: ${count}`);
  }

  if (result.importId !== null) {
    console.log('');
    row('Import record', result.importId);
  }
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

main()
  .then(() => getSql().end())
  .catch(async (error) => {
    console.error('History import failed:', error instanceof Error ? error.message : error);
    await getSql().end().catch(() => {});
    process.exit(1);
  });
