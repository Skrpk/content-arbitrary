/**
 * Read a public Telegram channel's latest posts from its web page and store
 * them as a workspace's publication history — what onboarding in the bot
 * will do on its own (src/lib/onboarding/telegram-history.ts).
 *
 *   npm run history:crawl -- --workspace 2 --channel @name [--dry-run] [--chat-id -100…]
 *
 * The history is keyed by the channel's Bot API id, as a Telegram Desktop
 * export of it is, so a later export updates these items. The id comes from
 * --chat-id, else from the Bot API's getChat (TELEGRAM_BOT_TOKEN), else the
 * key falls back to tg:<username>.
 *
 * Safe to re-run: items already stored are updated in place. --dry-run reads
 * the channel and reports what would be stored, writing nothing.
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { workspaces } from '../src/db/schema';
import { getDb, getSql } from '../src/lib/db';
import { describeError } from '../src/lib/errors';
import { createLogger } from '../src/lib/logger';
import { dryRunReport, storeParsedPublicationHistory, type HistoryImportReport } from '../src/lib/history/import-history';
import { crawlChannelHistory, TELEGRAM_PUBLIC_ADAPTER } from '../src/lib/onboarding/telegram-history';
import { TelegramClient } from '../src/lib/telegram/client';
import { normalizeChannelUsername } from '../src/lib/telegram-channel/username';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const workspaceId = Number(argument('workspace'));
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) throw new Error('Pass the workspace: --workspace <id>');
  const channel = normalizeChannelUsername(argument('channel') ?? '');
  if (!channel.ok) throw new Error(`Pass a public channel: --channel @name (${channel.reason})`);
  const { username } = channel;
  const dryRun = process.argv.includes('--dry-run');

  const db = getDb();
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new Error(`No workspace ${workspaceId}`);

  const publicationKey = argument('chat-id') ?? (await chatIdOf(username)) ?? `tg:${username.toLowerCase()}`;
  const started = Date.now();
  const crawl = await crawlChannelHistory(username, { publicationKey });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const result = dryRun
    ? await dryRunReport(db, { workspaceId, adapterType: TELEGRAM_PUBLIC_ADAPTER, parsed: crawl.parsed })
    : await storeParsedPublicationHistory({
        db,
        workspaceId,
        source: {
          adapter: TELEGRAM_PUBLIC_ADAPTER,
          originalFilename: `t.me/s/${username}`,
          fileSha256: crawl.sha256,
          metadata: { inspected: crawl.inspected, usable: crawl.usable, exhausted: crawl.exhausted },
        },
        parsed: crawl.parsed,
        logger: createLogger({ app: 'content-arbitrary', surface: 'history-crawl' }),
      });

  print(result, workspace.name, { ...crawl, seconds });
}

/** The channel's Bot API id, `-100…`, when the bot can look it up; null otherwise. */
async function chatIdOf(username: string): Promise<string | null> {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.log('No TELEGRAM_BOT_TOKEN: keying history by username.');
    return null;
  }
  try {
    const chat = await new TelegramClient().getChat(`@${username}`);
    if (chat.type !== 'channel') throw new Error(`@${username} is a ${chat.type}, not a channel`);
    console.log(`getChat(@${username}) → ${chat.id} (${chat.title ?? 'no title'})`);
    return String(chat.id);
  } catch (error) {
    console.log(`getChat(@${username}) failed, keying history by username: ${describeError(error)}`);
    return null;
  }
}

function print(
  result: HistoryImportReport,
  workspaceName: string,
  crawl: { title: string | null; inspected: number; usable: number; exhausted: boolean; seconds: string },
) {
  const row = (label: string, value: number | string) =>
    console.log(`${`${label}:`.padEnd(16)}${typeof value === 'number' ? value.toLocaleString('en-US').padStart(9) : value}`);
  const date = (value: Date | null) => value?.toISOString().slice(0, 10) ?? '—';

  console.log('');
  console.log(result.dryRun ? 'Channel history — dry run, nothing written' : 'Channel history stored');
  console.log('');
  row('Workspace', workspaceName);
  row('Channel', `${crawl.title ?? '—'} (${result.publicationKey})`);
  row('Read in', `${crawl.seconds} s`);
  row('Messages seen', crawl.inspected);
  row('Usable kept', crawl.usable);
  if (crawl.exhausted) row('Note', 'the channel has no older posts');
  console.log('');
  if (result.dryRun) {
    row('New', result.counts.imported);
    row('Already stored', result.counts.unchanged);
  } else {
    row('Imported', result.counts.imported);
    row('Updated', result.counts.updated);
    row('Unchanged', result.counts.unchanged);
  }
  row('Text only', result.content.textOnly);
  row('With photo', result.content.withPhoto);
  row('With video', result.content.withVideo);
  row('Other media', result.content.otherMedia);
  row('Date range', `${date(result.firstPublishedAt)} → ${date(result.lastPublishedAt)}`);
  const skipped = Object.entries(result.skippedByReason);
  if (skipped.length > 0) {
    console.log('');
    console.log('Skipped:');
    for (const [reason, count] of skipped) console.log(`  ${reason}: ${count}`);
  }
  if (result.importId !== null) {
    console.log('');
    row('Import record', result.importId);
  }
}

main()
  .then(() => getSql().end())
  .catch(async (error) => {
    console.error('History crawl failed:', error instanceof Error ? error.message : error);
    await getSql().end().catch(() => {});
    process.exit(1);
  });
