/**
 * Score posts the editor has already decided, as Radar would have when they
 * arrived, through the Message Batches API (half price, usually done within
 * the hour), then see how it did with `npm run radar:report`.
 *
 *   npm run radar:backfill -- --workspace 2 [--min-per-class 5] [--limit 200] [--text-only] [--no-wait]
 *   npm run radar:backfill -- --workspace 2 --resume <batch id>
 *
 * Without --no-wait it submits, waits for the batch and reads the results in.
 * If it is interrupted while waiting, --resume picks the batch up again; do not
 * submit a second time, or the same posts are paid for twice.
 *
 * Needs ANTHROPIC_API_KEY, and the workspace's editorial_profile set. Safe to
 * re-run: scores already recorded are skipped, failed ones are retried.
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import Anthropic from '@anthropic-ai/sdk';
import { workspaces } from '../src/db/schema';
import { getDb, getSql } from '../src/lib/db';
import { getEnv } from '../src/lib/env';
import { createLogger } from '../src/lib/logger';
import { ingestRadarBatch, submitRadarBackfill, waitForBatch } from '../src/lib/radar/backfill';
import { RADAR_MODEL, RADAR_PROMPT_VERSION } from '../src/lib/radar/prompt';
import { TelegramClient } from '../src/lib/telegram/client';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const env = getEnv();
  const workspaceId = Number(argument('workspace'));
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) {
    throw new Error('Pass the workspace: --workspace <id>');
  }
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');

  const db = getDb();
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const logger = createLogger({ app: 'content-arbitrary', surface: 'radar-backfill' });

  let batchIds: string[];
  const resume = argument('resume');

  if (resume) {
    batchIds = [resume];
  } else {
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    if (!workspace) throw new Error(`No workspace ${workspaceId}`);
    if (!workspace.editorialProfile?.trim()) {
      throw new Error(`Workspace ${workspaceId} has no editorial_profile; Radar needs one`);
    }

    console.log(`Radar backfill: workspace ${workspaceId}, ${RADAR_MODEL}, ${RADAR_PROMPT_VERSION}`);
    const submitted = await submitRadarBackfill({
      db,
      client,
      telegram: process.argv.includes('--text-only') ? undefined : new TelegramClient(),
      workspaceId,
      profile: workspace.editorialProfile,
      minPerClass: Number(argument('min-per-class') ?? 5),
      limit: argument('limit') ? Number(argument('limit')) : undefined,
      logger,
    });
    console.log(submitted);
    batchIds = submitted.batchIds;

    if (batchIds.length === 0) {
      console.log('Nothing to score.');
      return;
    }
    if (process.argv.includes('--no-wait')) {
      for (const id of batchIds) {
        console.log(`Later: npm run radar:backfill -- --workspace ${workspaceId} --resume ${id}`);
      }
      return;
    }
  }

  for (const batchId of batchIds) {
    console.log(`Waiting for ${batchId} (if interrupted: --resume ${batchId})`);
    await waitForBatch(client, batchId, {
      onStatus: (batch) =>
        console.log(
          `  ${batch.processing_status}: ${batch.request_counts.succeeded} done, ` +
            `${batch.request_counts.processing} processing, ${batch.request_counts.errored} errored`,
        ),
    });
    console.log(await ingestRadarBatch({ db, client, batchId, workspaceId, logger }));
  }

  console.log(`Next: npm run radar:report -- --workspace ${workspaceId}`);
}

main()
  .then(() => getSql().end())
  .catch(async (error) => {
    console.error('Radar backfill failed:', error instanceof Error ? error.message : error);
    await getSql().end().catch(() => {});
    process.exit(1);
  });
