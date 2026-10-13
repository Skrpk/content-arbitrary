/**
 * Place a workspace's posts in stories — the ones that arrived before story
 * clustering ran live, or all of them again — and print what came of it.
 *
 *   npm run stories:cluster -- --workspace 2
 *   npm run stories:cluster -- --workspace 2 --rebuild --threshold 0.72 --dry-run
 *
 * Posts are placed in the order they arrived, each against the posts before
 * it, exactly as live. Only posts with a vector are placed: run
 * `npm run history:embed` first for posts Radar never searched with. No API
 * calls. --rebuild forgets the workspace's stories first; --dry-run does all
 * of it in a transaction that is rolled back, to try a threshold; --show sets
 * how many stories are listed (25 by default); --report only prints.
 */
import 'dotenv/config';
import { getDb, getSql } from '../src/lib/db';
import { getEnv } from '../src/lib/env';
import { deleteStories, loadUnplacedPosts, placeInStory, STORY_SIMILARITY_THRESHOLD } from '../src/lib/stories/cluster';
import { formatStoryReport, loadStoryReportRows } from '../src/lib/stories/report';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

class RolledBack extends Error {}

async function main() {
  const env = getEnv();
  const workspaceId = Number(argument('workspace'));
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) {
    throw new Error('Pass the workspace: --workspace <id>');
  }
  const threshold = Number(argument('threshold') ?? STORY_SIMILARITY_THRESHOLD);
  if (!(threshold > 0 && threshold <= 1)) throw new Error('--threshold is a similarity between 0 and 1');
  const show = Number(argument('show') ?? 25);
  const dryRun = process.argv.includes('--dry-run');
  const model = env.HISTORY_EMBEDDING_MODEL;
  const db = getDb();

  if (process.argv.includes('--report')) {
    console.log(formatStoryReport(await loadStoryReportRows(db, workspaceId), { show }));
    return;
  }

  try {
    await db.transaction(async (tx) => {
      if (process.argv.includes('--rebuild')) await deleteStories(tx, workspaceId);
      const posts = await loadUnplacedPosts(tx, { workspaceId, model });
      const counts = { joined: 0, started: 0 };
      for (const processedPostId of posts) {
        const placement = await placeInStory(tx, { workspaceId, processedPostId, model, threshold });
        if (placement && placement.outcome !== 'existing') counts[placement.outcome] += 1;
      }
      console.log(
        `${dryRun ? 'Dry run: would place' : 'Placed'} ${posts.length} posts at threshold ${threshold}: ` +
          `${counts.started} started a story, ${counts.joined} joined one\n`,
      );
      console.log(formatStoryReport(await loadStoryReportRows(tx, workspaceId), { show }));
      if (dryRun) throw new RolledBack();
    });
  } catch (error) {
    if (!(error instanceof RolledBack)) throw error;
  }
}

main()
  .then(() => getSql().end())
  .catch(async (error) => {
    console.error('Story clustering failed:', error instanceof Error ? error.message : error);
    await getSql().end().catch(() => {});
    process.exit(1);
  });
