/**
 * Embed a workspace's imported publication history, so Shadow Radar's
 * retrieval prompt can find the past publications most similar to a new post.
 *
 *   npm run history:embed -- --workspace 2 [--dry-run]
 *
 * Uses OpenAI's HISTORY_EMBEDDING_MODEL (text-embedding-3-small by default)
 * and OPENAI_API_KEY, whatever RADAR_PROVIDER is. Incremental: only items that
 * have no vector for that model, or whose text changed since, are embedded —
 * run it after every `npm run history:import`. Items without text are left
 * without a vector. --dry-run counts what would be embedded and calls nothing.
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { workspaces } from '../src/db/schema';
import { getDb, getSql } from '../src/lib/db';
import { getEnv } from '../src/lib/env';
import { createLogger } from '../src/lib/logger';
import { embedPublicationHistory } from '../src/lib/history/embeddings/embed';
import { createEmbeddingProvider, embeddingCostUsd } from '../src/lib/history/embeddings/provider';

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
  const embeddings = createEmbeddingProvider(env);
  if (!embeddings) throw new Error('OPENAI_API_KEY is not set; history embeddings use OpenAI');

  const db = getDb();
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new Error(`No workspace ${workspaceId}`);

  const dryRun = process.argv.includes('--dry-run');
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort(new Error('interrupted')));

  const summary = await embedPublicationHistory({
    db,
    embeddings,
    workspaceId,
    dryRun,
    logger: createLogger({ app: 'content-arbitrary', surface: 'history-embed' }),
    signal: controller.signal,
  });

  const row = (label: string, value: string | number) => console.log(`${`${label}:`.padEnd(20)}${value}`);
  const cost = embeddingCostUsd(summary.model, summary.inputTokens);

  console.log('');
  console.log(dryRun ? 'History embedding (dry run: nothing embedded)' : 'History embedding completed');
  console.log('');
  row('Workspace', `${workspace.name} (${workspaceId})`);
  row('Model', summary.model);
  console.log('');
  row('History items', summary.items);
  row('Eligible text', summary.eligible);
  row('Already embedded', summary.alreadyEmbedded);
  row(dryRun ? 'Would embed' : 'Embedded', summary.embedded);
  row(dryRun ? 'Would re-embed' : 'Re-embedded', `${summary.reembedded} (text changed)`);
  row('Skipped no text', summary.skippedNoText);
  if (summary.removedStale > 0) row(dryRun ? 'Would remove' : 'Removed stale', summary.removedStale);
  row('Failed', summary.failed);
  if (!dryRun) {
    console.log('');
    row('Requests', summary.requests);
    row('Input tokens', summary.inputTokens);
    row('Estimated cost', cost === null ? 'n/a (model not priced here)' : `$${cost.toFixed(6)}`);
  }
  if (summary.failed > 0) process.exitCode = 1;
}

main()
  .then(() => getSql().end())
  .catch(async (error) => {
    console.error('History embedding failed:', error instanceof Error ? error.message : error);
    await getSql().end().catch(() => {});
    process.exit(1);
  });
