/**
 * Distil a workspace's imported publication history into a compact editorial
 * profile, which live Shadow Radar then reads as background context.
 *
 *   npm run history:profile -- --workspace 2 [--force] [--dry-run]
 *
 * Uses RADAR_PROVIDER's model and API key. Run it after importing history
 * (npm run history:import); on unchanged history it does nothing and costs
 * nothing, unless --force. --dry-run generates and prints the profile without
 * storing it — the model calls are still made and billed.
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { workspaces } from '../src/db/schema';
import { getDb, getSql } from '../src/lib/db';
import { getEnv } from '../src/lib/env';
import { createLogger } from '../src/lib/logger';
import { buildPublicationProfile, type ProfileBuildResult } from '../src/lib/history/profile/build';
import { createRadarProvider } from '../src/lib/radar/providers';
import { costUsd } from '../src/lib/radar/report';

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
  const provider = createRadarProvider(env);
  if (!provider) {
    throw new Error(`${env.RADAR_PROVIDER === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} is not set`);
  }

  const db = getDb();
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new Error(`No workspace ${workspaceId}`);

  console.log(`Profiling the publication history of workspace ${workspaceId} with ${provider.model}…`);
  const result = await buildPublicationProfile({
    db,
    provider,
    workspaceId,
    force: process.argv.includes('--force'),
    dryRun: process.argv.includes('--dry-run'),
    logger: createLogger({ app: 'content-arbitrary', surface: 'history-profile' }),
  });

  print(result, workspace.name);
}

function print(result: ProfileBuildResult, workspaceName: string) {
  const { facts, profile } = result;
  const row = (label: string, value: string | number) => console.log(`${`${label}:`.padEnd(18)}${value}`);
  const day = (date: Date) => date.toISOString().slice(0, 10);

  console.log('');
  console.log('Publication history profile');
  console.log('');
  row('Workspace', workspaceName);
  row('Items considered', facts.items);
  row('Text items used', facts.textItems);
  row('Media only', facts.mediaOnlyItems);
  row('Date range', `${day(facts.firstPublishedAt)} → ${day(facts.lastPublishedAt)}`);
  row('History cutoff', result.historyCutoffAt.toISOString());
  row('Fingerprint', result.sourceFingerprint);
  row('Model', result.model);
  row('Prompt version', result.promptVersion);

  if (result.stale) {
    console.log('');
    console.log(
      `The previous profile (id ${result.stale.profileId}, from ${result.stale.sourceItemCount} items) ` +
        `was made from different history.`,
    );
  }

  if (result.status === 'up_to_date') {
    console.log('');
    console.log(`Profile is up to date (id ${result.profileId}). Nothing to regenerate; --force to redo it.`);
    return;
  }

  console.log('');
  console.log(JSON.stringify(profile, null, 2));
  console.log('');
  const cost = costUsd(result.model, result.usage);
  row('Batches', result.batches);
  row('Model calls', result.calls);
  row(
    'Tokens',
    `${result.usage.inputTokens} in, ${result.usage.outputTokens} out` +
      (cost === null ? '' : ` ≈ $${cost.toFixed(4)}`),
  );
  console.log('');
  console.log(
    result.status === 'dry_run'
      ? 'Dry run: profile not stored.'
      : `Profile stored: id=${result.profileId}. Live Radar uses it from now on.`,
  );
}

main()
  .then(() => getSql().end())
  .catch(async (error) => {
    console.error('History profile failed:', error instanceof Error ? error.message : error);
    await getSql().end().catch(() => {});
    process.exit(1);
  });
