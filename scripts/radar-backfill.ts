/**
 * Score posts the editor has already decided, as Radar would have when they
 * arrived, through the provider's batch API (half price, usually done within
 * the hour), then see how it did with `npm run radar:report`.
 *
 * The provider is RADAR_PROVIDER (openai by default, or anthropic), with its
 * API key; a resumed batch is read with the provider it was submitted to.
 *
 *   npm run radar:backfill -- --workspace 2 [--prompt radar-v1,radar-v2-history-retrieval]
 *       [--min-per-class 5] [--limit 200] [--text-only] [--no-wait]
 *   npm run radar:backfill -- --workspace 2 --resume <batch id>
 *
 * Every prompt version by default, in the same batch, so the baseline and the
 * retrieval prompt are scored on exactly the same posts; --prompt picks some.
 * The retrieval prompt needs OPENAI_API_KEY for embeddings, and the history
 * embedded first (npm run history:embed); do not re-embed history while a
 * batch is pending, or what is recorded as shown may differ from what was.
 *
 * Without --no-wait it submits, waits for the batch and reads the results in.
 * If it is interrupted while waiting, --resume picks the batch up again; do not
 * submit a second time, or the same posts are paid for twice.
 *
 * Needs the provider's API key, and the workspace's editorial_profile set. Safe to
 * re-run: scores already recorded are skipped, failed ones are retried.
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { workspaces } from '../src/db/schema';
import { getDb, getSql } from '../src/lib/db';
import { getEnv } from '../src/lib/env';
import { createLogger } from '../src/lib/logger';
import { ingestRadarBatch, submitRadarBackfill, waitForBatch } from '../src/lib/radar/backfill';
import { createEmbeddingProvider } from '../src/lib/history/embeddings/provider';
import {
  isRadarPromptVersion,
  RADAR_PROMPT_VERSIONS,
  usesHistoryRetrieval,
  type RadarPromptVersion,
} from '../src/lib/radar/prompt';
import { createRadarProvider, providerOfBatch } from '../src/lib/radar/providers';
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
  const resume = argument('resume');
  const providerName = resume ? providerOfBatch(resume) : env.RADAR_PROVIDER;
  if (!providerName) throw new Error(`Not a batch id this script submits: ${resume}`);

  const provider = createRadarProvider(env, providerName);
  if (!provider) {
    throw new Error(
      `${providerName === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} is not set`,
    );
  }

  const db = getDb();
  const logger = createLogger({ app: 'content-arbitrary', surface: 'radar-backfill' });

  let batchIds: string[];

  if (resume) {
    batchIds = [resume];
  } else {
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    if (!workspace) throw new Error(`No workspace ${workspaceId}`);
    if (!workspace.editorialProfile?.trim()) {
      throw new Error(`Workspace ${workspaceId} has no editorial_profile; Radar needs one`);
    }

    const promptVersions = parsePromptVersions(argument('prompt'));
    const embeddings = createEmbeddingProvider(env);
    if (promptVersions.some(usesHistoryRetrieval) && !embeddings) {
      throw new Error('The retrieval prompt needs OPENAI_API_KEY for embeddings; or pass --prompt radar-v1');
    }

    console.log(
      `Radar backfill: workspace ${workspaceId}, ${provider.name} ${provider.model}, ${promptVersions.join(' + ')}`,
    );
    const submitted = await submitRadarBackfill({
      db,
      provider,
      telegram: new TelegramClient(),
      textOnly: process.argv.includes('--text-only'),
      promptVersions,
      embeddings,
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
    await waitForBatch(provider, batchId, { onStatus: (status) => console.log(`  ${status}`) });
    console.log(
      await ingestRadarBatch({
        db,
        provider,
        batchId,
        workspaceId,
        embeddingModel: env.HISTORY_EMBEDDING_MODEL,
        logger,
      }),
    );
  }

  console.log(`Next: npm run radar:report -- --workspace ${workspaceId}`);
}

function parsePromptVersions(value: string | undefined): RadarPromptVersion[] {
  if (!value) return [...RADAR_PROMPT_VERSIONS];
  const versions = value.split(',').map((version) => version.trim());
  for (const version of versions) {
    if (!isRadarPromptVersion(version)) {
      throw new Error(`Unknown prompt version "${version}"; known: ${RADAR_PROMPT_VERSIONS.join(', ')}`);
    }
  }
  return versions as RadarPromptVersion[];
}

main()
  .then(() => getSql().end())
  .catch(async (error) => {
    console.error('Radar backfill failed:', error instanceof Error ? error.message : error);
    await getSql().end().catch(() => {});
    process.exit(1);
  });
