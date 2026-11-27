/**
 * Find sources for a workspace's channel as onboarding will (§15–§19), and
 * print what would be connected — nothing is stored.
 *
 *   npm run onboarding:discover -- --workspace 2 --channel @name [--no-search]
 *
 * Reads the channel's history already stored for the workspace (run
 * `npm run history:crawl` first), its editorial profile and language. The web
 * search uses OPENAI_API_KEY and ASSISTANT_MODEL, and is billed; --no-search
 * uses the history alone.
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { workspaces } from '../src/db/schema';
import { getDb, getSql } from '../src/lib/db';
import { getEnv } from '../src/lib/env';
import { createLogger } from '../src/lib/logger';
import { latestPublicationProfile } from '../src/lib/history/profile/repository';
import { publicationProfileSchema } from '../src/lib/history/profile/schema';
import { discoverSources, type CheckedCandidate } from '../src/lib/onboarding/discover-sources';
import { loadHistorySignals } from '../src/lib/onboarding/link-signals';
import { createDiscoverer } from '../src/lib/onboarding/source-discovery';
import { normalizeChannelUsername } from '../src/lib/telegram-channel/username';
import { YouTubeClient } from '../src/lib/youtube/client';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const env = getEnv();
  const workspaceId = Number(argument('workspace'));
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) throw new Error('Pass the workspace: --workspace <id>');
  const channel = normalizeChannelUsername(argument('channel') ?? '');
  if (!channel.ok) throw new Error('Pass the channel: --channel @name');

  const db = getDb();
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace?.telegramChatId) throw new Error(`No workspace ${workspaceId} with a channel`);
  const logger = createLogger({ app: 'content-arbitrary', surface: 'onboarding-discover' });

  const history = await loadHistorySignals(db, { workspaceId, publicationKey: workspace.telegramChatId });
  if (history.length === 0) throw new Error(`No history stored under ${workspace.telegramChatId}: run npm run history:crawl first`);
  const profile = await latestPublicationProfile(db, workspaceId);
  const topics = profile ? publicationProfileSchema.parse(profile.profile).coreTopics.map((topic) => topic.name) : [];

  const started = Date.now();
  const result = await discoverSources(
    {
      channel: { username: channel.username, title: workspace.name, language: workspace.language, editorialProfile: workspace.editorialProfile, topics },
      history,
    },
    {
      youtube: env.YOUTUBE_API_KEY ? new YouTubeClient({ apiKey: env.YOUTUBE_API_KEY, logger }) : null,
      discoverer: process.argv.includes('--no-search') ? null : createDiscoverer(env),
      logger,
    },
  );

  const line = (candidate: CheckedCandidate) =>
    `${String(candidate.score).padStart(5)}  ${candidate.source.platform.padEnd(8)} ${(candidate.name ?? candidate.source.username).slice(0, 40).padEnd(40)} ` +
    `${candidate.origin.padEnd(15)} ${candidate.forwards ? `fwd ${candidate.forwards} ` : ''}${candidate.links ? `links ${candidate.links} ` : ''}${candidate.via ? `via ${candidate.via} ` : ''}\n` +
    `       ${candidate.source.externalId}${candidate.reason ? `\n       ${candidate.reason}` : ''}`;

  console.log('');
  console.log(`Sources for ${workspace.name} — ${Math.round((Date.now() - started) / 1000)} s`);
  console.log(JSON.stringify(result.stats));
  console.log('\nPicked:');
  for (const candidate of result.picked) console.log(line(candidate));
  console.log('\nReserve:');
  for (const candidate of result.reserve) console.log(line(candidate));
  if (result.failed.length > 0) {
    console.log('\nFailed:');
    for (const failure of result.failed) console.log(`  ${failure.key} (${failure.origin}): ${failure.reason}`);
  }
}

main()
  .then(() => getSql().end())
  .catch(async (error) => {
    console.error('Discovery failed:', error instanceof Error ? error.message : error);
    await getSql().end().catch(() => {});
    process.exit(1);
  });
