/**
 * Creates the demo channel app store reviewers sign in to
 * (src/lib/accounts/review-access.ts), with a few public feeds so its review
 * queue has posts to decide.
 *
 *   npm run review-workspace -- --channel -1001234567890 --admin 123456789 [--feed <url> ...]
 *
 * `channel` is the demo Telegram channel's id — the bot must be an
 * administrator there; `admin` is your own Telegram user id, where the demo
 * channel's notifications go. Prints the new workspace's id: set it as
 * REVIEW_LOGIN_WORKSPACE_ID. Run it once; it refuses a channel already in use.
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { workspaces } from '../src/db/schema';
import { getDb, getSql } from '../src/lib/db';
import { addRssSource } from '../src/lib/sources/add-rss';

const DEFAULT_FEEDS = ['https://www.nasa.gov/news-release/feed/', 'https://www.esa.int/rssfeed/Our_Activities/Space_Science'];

function options(name: string): string[] {
  return process.argv.flatMap((value, index) => (process.argv[index - 1] === `--${name}` ? [value] : []));
}

async function main() {
  const [channel] = options('channel');
  const [admin] = options('admin');
  if (!channel || !/^-?\d+$/.test(channel) || !admin || !/^\d+$/.test(admin)) {
    throw new Error('usage: review-workspace --channel <chat id> --admin <your telegram id> [--feed <url> ...]');
  }
  const db = getDb();
  const [taken] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.telegramChatId, channel));
  if (taken) throw new Error(`channel ${channel} already belongs to workspace ${taken.id}`);

  const [workspace] = await db
    .insert(workspaces)
    .values({ name: 'Zmistik demo', telegramChatId: channel, telegramAdminChatId: admin })
    .returning();
  console.log(`Created workspace ${workspace!.id} (Zmistik demo).`);

  const feeds = options('feed');
  for (const url of feeds.length > 0 ? feeds : DEFAULT_FEEDS) {
    const result = await addRssSource(db, { url, workspaceId: workspace!.id });
    console.log(result.ok ? `  + ${result.title}` : `  ! ${url}: ${result.reason}`);
  }
  console.log(`\nSet REVIEW_LOGIN_WORKSPACE_ID=${workspace!.id} in Vercel.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => getSql().end());
