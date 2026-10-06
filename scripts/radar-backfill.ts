/**
 * Score posts the editor has already decided, as Radar would have when they
 * arrived, then see how it did with `npm run radar:report`.
 *
 *   npm run radar:backfill -- --workspace 2 [--min-per-class 5] [--limit 200] [--text-only]
 *
 * Needs ANTHROPIC_API_KEY, and the workspace's editorial_profile set. Safe to
 * re-run: posts already scored under the current prompt are skipped.
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import Anthropic from '@anthropic-ai/sdk';
import { workspaces } from '../src/db/schema';
import { getDb, getSql } from '../src/lib/db';
import { getEnv } from '../src/lib/env';
import { createLogger } from '../src/lib/logger';
import { runRadarBackfill } from '../src/lib/radar/backfill';
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
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new Error(`No workspace ${workspaceId}`);
  if (!workspace.editorialProfile?.trim()) {
    throw new Error(`Workspace ${workspaceId} has no editorial_profile; Radar needs one`);
  }

  console.log(`Radar backfill: workspace ${workspaceId}, ${RADAR_MODEL}, ${RADAR_PROMPT_VERSION}`);

  const summary = await runRadarBackfill({
    db,
    client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }),
    telegram: process.argv.includes('--text-only') ? undefined : new TelegramClient(),
    workspaceId,
    profile: workspace.editorialProfile,
    minPerClass: Number(argument('min-per-class') ?? 5),
    limit: argument('limit') ? Number(argument('limit')) : undefined,
    logger: createLogger({ app: 'content-arbitrary', surface: 'radar-backfill' }),
    onProgress: (done, total) => process.stdout.write(`\r${done}/${total}`),
  });

  console.log('\n', summary);
  console.log('Next: npm run radar:report -- --workspace', workspaceId);
  await getSql().end();
}

main().catch(async (error) => {
  console.error('Radar backfill failed:', error instanceof Error ? error.message : error);
  await getSql().end().catch(() => {});
  process.exit(1);
});
