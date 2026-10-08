/**
 * Look at the images of a workspace's imported publication history once, and
 * store what each shows, so history:embed can embed it with the text — an
 * image-only post then becomes searchable — and Radar's media prompt can read
 * it.
 *
 *   npm run history:understand-images -- --workspace 2 --media-root ./ChatExport_2026-10-06 \
 *       [--limit 50] [--dry-run]
 *
 * --media-root is the Telegram export's folder (the one with result.json and
 * photos/): each item's stored relativePath is read under it. Only the first
 * photo of an item is looked at. Items whose photo the export left out, or
 * whose file is missing, are counted and skipped. Resumable and safe to
 * re-run: what is already understood for MEDIA_UNDERSTANDING_MODEL and the
 * current prompt is not sent again. --limit caps how many images are sent
 * this run; --dry-run counts what would be sent and calls nothing.
 *
 * Then: npm run history:embed -- --workspace 2
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { workspaces } from '../src/db/schema';
import { getDb, getSql } from '../src/lib/db';
import { getEnv } from '../src/lib/env';
import { createLogger } from '../src/lib/logger';
import { understandHistoryImages } from '../src/lib/media/history';
import { createImageUnderstander } from '../src/lib/media/provider';
import { mediaUnderstandingConfig } from '../src/lib/media/understanding';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const env = getEnv();
  const workspaceId = Number(argument('workspace'));
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) throw new Error('Pass the workspace: --workspace <id>');
  const mediaRoot = argument('media-root');
  if (!mediaRoot) throw new Error("Pass the export's folder: --media-root <path>");
  const limit = argument('limit') === undefined ? undefined : Number(argument('limit'));
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error('--limit must be a whole number');
  const dryRun = process.argv.includes('--dry-run');

  const db = getDb();
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new Error(`No workspace ${workspaceId}`);

  const config = mediaUnderstandingConfig(env);
  const summary = await understandHistoryImages({
    db,
    understander: createImageUnderstander(env),
    config,
    workspaceId,
    mediaRoot,
    limit,
    dryRun,
    logger: createLogger({ app: 'content-arbitrary', surface: 'history-understand-images' }),
  });

  const row = (label: string, value: string | number) => console.log(`${`${label}:`.padEnd(22)}${value}`);
  console.log('');
  console.log(dryRun ? 'Image understanding (dry run: nothing sent)' : 'Image understanding completed');
  console.log('');
  row('Workspace', `${workspace.name} (${workspaceId})`);
  row('Model', `${config.model}, ${config.promptVersion}, detail ${config.detail}`);
  row('Items with a photo', summary.imageItems);
  row('Skipped unavailable', summary.unavailable);
  row('Already understood', summary.alreadyUnderstood);
  row(dryRun ? 'Would understand' : 'Sent', summary.toUnderstand);
  if (summary.overLimit > 0) row('Left by --limit', summary.overLimit);
  if (!dryRun) {
    row('Understood', summary.understood);
    row('Failed', summary.failed);
    row('Tokens in / out', `${summary.inputTokens} / ${summary.outputTokens}`);
    row('Estimated cost', `$${summary.costUsd.toFixed(4)}`);
    console.log('');
    console.log(`Next: npm run history:embed -- --workspace ${workspaceId}`);
  }
  if (summary.failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('Image understanding failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => getSql().end().catch(() => {}));
