/**
 * Embed a workspace's imported publication history, and the posts that went
 * through its review, so Shadow Radar's retrieval prompts can find the past
 * publications — and the already approved posts — most similar to a new one.
 *
 *   npm run history:embed -- --workspace 2 [--dry-run]
 *
 * Uses OpenAI's HISTORY_EMBEDDING_MODEL (text-embedding-3-small by default)
 * and OPENAI_API_KEY, whatever RADAR_PROVIDER is. Incremental: only items that
 * have no vector for that model, or whose text changed since, are embedded —
 * run it after every `npm run history:import`. What each item's first image
 * shows is embedded with its text once `npm run history:understand-images`
 * has looked at it, so run this after that too; only the items whose image
 * was newly understood are embedded again. Items with neither text nor an
 * understood image are left without a vector. --dry-run counts what would be
 * embedded and calls nothing.
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { workspaces } from '../src/db/schema';
import { getDb, getSql } from '../src/lib/db';
import { getEnv } from '../src/lib/env';
import { createLogger } from '../src/lib/logger';
import {
  embedProcessedPosts,
  embedPublicationHistory,
  type HistoryEmbeddingSummary,
} from '../src/lib/history/embeddings/embed';
import { createEmbeddingProvider, embeddingCostUsd } from '../src/lib/history/embeddings/provider';
import { mediaUnderstandingConfig } from '../src/lib/media/understanding';

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

  const options = {
    db,
    embeddings,
    workspaceId,
    dryRun,
    // What images were understood is embedded with the text: run after history:understand-images.
    mediaConfig: mediaUnderstandingConfig(env),
    logger: createLogger({ app: 'content-arbitrary', surface: 'history-embed' }),
    signal: controller.signal,
  };
  const history = await embedPublicationHistory(options);
  const posts = await embedProcessedPosts(options);

  const row = (label: string, value: string | number) => console.log(`${`${label}:`.padEnd(20)}${value}`);
  const section = (title: string, summary: HistoryEmbeddingSummary, noun: string) => {
    console.log('');
    console.log(title);
    row(noun, summary.items);
    row('Eligible', `${summary.eligible} (text, or an understood image)`);
    row('Already embedded', summary.alreadyEmbedded);
    row(dryRun ? 'Would embed' : 'Embedded', summary.embedded);
    row(dryRun ? 'Would re-embed' : 'Re-embedded', `${summary.reembedded} (text or image understanding changed)`);
    row('Skipped no text', `${summary.skippedNoText} (no text and no understood image)`);
    if (summary.removedStale > 0) row(dryRun ? 'Would remove' : 'Removed stale', summary.removedStale);
    row('Failed', summary.failed);
  };

  console.log('');
  console.log(dryRun ? 'History embedding (dry run: nothing embedded)' : 'History embedding completed');
  console.log('');
  row('Workspace', `${workspace.name} (${workspaceId})`);
  row('Model', embeddings.model);
  section('Publication history', history, 'History items');
  section('Processed posts (to spot repeats of approved ones)', posts, 'Posts');
  if (!dryRun) {
    const inputTokens = history.inputTokens + posts.inputTokens;
    const cost = embeddingCostUsd(embeddings.model, inputTokens);
    console.log('');
    row('Requests', history.requests + posts.requests);
    row('Input tokens', inputTokens);
    row('Estimated cost', cost === null ? 'n/a (model not priced here)' : `$${cost.toFixed(6)}`);
  }
  if (history.failed + posts.failed > 0) process.exitCode = 1;
}

main()
  .then(() => getSql().end())
  .catch(async (error) => {
    console.error('History embedding failed:', error instanceof Error ? error.message : error);
    await getSql().end().catch(() => {});
    process.exit(1);
  });
