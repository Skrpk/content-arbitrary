import type { Database } from '@/lib/db';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { escapeHtml } from '@/lib/telegram/format-caption';
import { normalizeXUsername } from '@/lib/sources/normalize';
import { addSource, updateSourceUsername } from '@/lib/sources/repository';
import type { XClient } from '@/lib/x/client';
import { formatScheduleTime } from '@/lib/sync/approval';
import { listScheduledPosts } from '@/lib/sync/repository';
import type { InlineKeyboardMarkup } from '@/lib/telegram/send-media';

/**
 * Slash commands for managing the source list from the bot's private chat.
 *
 * Deliberately stateless: every command carries its own argument, so there is
 * no half-finished conversation to remember between webhook calls — which
 * matters on a serverless runtime where nothing survives an invocation.
 *
 * Handlers return the reply text. Authorisation is the caller's job, so that
 * the single admin check in the webhook stays the only one.
 *
 * A reviewer of several channels is asked which one a command is for, with a
 * button per channel; the button carries the whole command, so even that
 * question needs no state between calls.
 */

export interface CommandReply {
  text: string;
  /**
   * The reply concerns sources that exist, so it should carry the button that
   * opens their settings. The webhook adds it when a Mini App is configured,
   * below the stats button when there is one.
   */
  offerSettings?: boolean;
  /** The reply should carry the button that opens the source stats page. */
  offerStats?: boolean;
  /** Buttons that belong to the reply itself, such as a choice of channel. */
  replyMarkup?: InlineKeyboardMarkup;
}

/** A channel the reviewer works on, as the commands need to name it. */
export interface WorkspaceRef {
  id: number;
  name: string;
}

/** Absolute URL of the Mini App page with every source's settings. */
export function buildSettingsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/settings`;
}

/** Absolute URL of the Mini App page with every source's stats. */
export function buildSourceStatsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/source-stats`;
}

export interface ParsedCommand {
  command: string;
  args: string;
}

/**
 * Pull `/command args` out of a message.
 *
 * Telegram appends `@botname` to commands sent in groups; harmless here, but
 * accepted so the same message works if the bot is ever added to one.
 */
export function parseCommand(text: string | undefined): ParsedCommand | null {
  if (!text) return null;

  const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;

  return { command: match[1]!.toLowerCase(), args: (match[2] ?? '').trim() };
}

export interface CommandContext {
  db: Database;
  xClient: XClient;
  logger: Logger;
  /**
   * The tenant whose sources this command acts on, resolved from the sender by
   * the webhook. Every repository call below is scoped to it, so one reviewer
   * can never list or change another tenant's accounts.
   */
  workspaceId: number;
  /**
   * Every tenant the sender reviews for, when there is more than one. Lists
   * then cover them all, and a command about one source asks which channel.
   */
  workspaces?: WorkspaceRef[];
}

/**
 * The commands that act on one source in one channel — now only adding one:
 * pausing, resuming and removing are buttons on the /sourcestats page.
 */
type SourceCommand = 'addsource';

const CHOICE_CODES: Record<SourceCommand, string> = {
  addsource: 'a',
};

const CHOICE_QUESTIONS: Record<SourceCommand, (handle: string) => string> = {
  addsource: (handle) => `Add <b>@${handle}</b> to which channel?`,
};

/** Commands that /sourcestats replaced, answered with a pointer there. */
const MOVED_TO_STATS = new Set(['sources', 'removesource', 'deletesource', 'pausesource', 'resumesource']);

/** A channel button's data, well inside Telegram's 64 bytes: `wc:a:12:karpathy`. */
export function buildChannelChoiceData(
  command: SourceCommand,
  workspaceId: number,
  username: string,
): string {
  return `wc:${CHOICE_CODES[command]}:${workspaceId}:${username}`;
}

/**
 * Read a channel button back. Untrusted like any callback: the caller must
 * still check the workspace is one the presser reviews for.
 */
export function parseChannelChoice(
  data: string | undefined,
): { command: SourceCommand; workspaceId: number; username: string } | null {
  const match = /^wc:(a):(\d{1,12}):([A-Za-z0-9_]{1,15})$/.exec(data?.trim() ?? '');
  if (!match) return null;

  const workspaceId = Number(match[2]);
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) return null;

  const command = (Object.keys(CHOICE_CODES) as SourceCommand[]).find(
    (key) => CHOICE_CODES[key] === match[1],
  )!;
  return { command, workspaceId, username: match[3]! };
}

/** The channels a command covers: all of the sender's, or the one it acts on. */
function channelsOf(context: CommandContext): WorkspaceRef[] {
  return context.workspaces && context.workspaces.length > 0
    ? context.workspaces
    : [{ id: context.workspaceId, name: '' }];
}

/**
 * The commands in the bot's menu, beside the message field — registered with
 * Telegram by `npm run telegram:commands`. Rerun that after changing this.
 * Telegram takes names of 1–32 lowercase letters, digits and underscores, and
 * descriptions of up to 256 characters.
 */
export const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: 'sourcestats', description: 'How each source performs: posts, approvals, cost' },
  { command: 'addsource', description: 'Start watching an account: /addsource @username' },
  { command: 'scheduled', description: 'Posts waiting to be published at a set time' },
  { command: 'help', description: 'What the bot can do' },
];

const HELP_TEXT = [
  '<b>Source management</b>',
  '',
  '/sourcestats — every source and how it performs: posts, approvals, cost',
  '/addsource @username — start watching an account',
  '',
  'Pause, resume or remove a source with the buttons under it in /sourcestats; options such as mirroring ' +
    'posts without media are under its ⚙️ Settings button.',
  '',
  '<b>Publishing</b>',
  '',
  '/scheduled — posts waiting to be published at a set time',
  '',
  '/help — this list',
].join('\n');

/** Argument handling for a command that takes a handle. */
async function resolveHandleArgument(
  args: string,
  usage: string,
): Promise<{ ok: true; username: string } | { ok: false; reply: string }> {
  if (args === '') return { ok: false, reply: `Usage: <code>${escapeHtml(usage)}</code>` };

  const normalized = normalizeXUsername(args);
  if (normalized.ok) return { ok: true, username: normalized.username };

  const reason =
    normalized.reason === 'reserved'
      ? 'That looks like an x.com page, not an account.'
      : 'That is not a valid X handle. Handles are 1–15 characters: letters, digits and underscore.';

  return { ok: false, reply: `⚠️ ${reason}` };
}

export async function handleAddSource(
  context: CommandContext,
  args: string,
): Promise<CommandReply> {
  const resolved = await resolveHandleArgument(args, '/addsource @username');
  if (!resolved.ok) return { text: resolved.reply };

  let user: { id: string; username: string };
  try {
    // The X API is the authority on both existence and the numeric id.
    user = await context.xClient.getUserByUsername(resolved.username);
  } catch (error) {
    context.logger.warn('command.addsource_resolve_failed', {
      username: resolved.username,
      error: describeError(error),
    });
    return {
      text:
        `⚠️ Could not find <b>@${escapeHtml(resolved.username)}</b> on X.\n\n` +
        'The account may not exist, or it may be protected or suspended.',
    };
  }

  const result = await addSource(context.db, {
    platform: 'x',
    externalId: user.id,
    username: user.username,
    workspaceId: context.workspaceId,
  });

  if (!result.created) {
    const note = result.source.enabled
      ? ''
      : '\n\nIt is currently paused — resume it in /sourcestats.';
    return {
      text: `ℹ️ <b>@${escapeHtml(user.username)}</b> is already in your sources.${note}`,
      offerSettings: true,
    };
  }

  context.logger.info('command.source_added', {
    workspaceId: context.workspaceId,
    username: user.username,
    externalId: user.id,
  });
  return {
    text:
      `✅ <b>Source added</b>\n\n@${escapeHtml(user.username)}\n\n` +
      'Posts with photos or videos only. Use Settings to mirror text posts too.',
    offerSettings: true,
  };
}

/**
 * The scheduled posts of every channel the sender reviews, soonest first, each
 * at the time it was picked in — and, across several channels, which one.
 */
export async function handleScheduled(context: CommandContext): Promise<string> {
  const channels = channelsOf(context);
  const posts = (
    await Promise.all(
      channels.map(async (channel) =>
        (await listScheduledPosts(context.db, channel.id)).map((post) => ({ post, channel })),
      ),
    )
  )
    .flat()
    .sort(
      (a, b) => (a.post.scheduledFor?.getTime() ?? 0) - (b.post.scheduledFor?.getTime() ?? 0),
    );

  if (posts.length === 0) {
    return 'Nothing scheduled. Use 🕒 Schedule under a post in review.';
  }

  const lines = posts.map(({ post, channel }) => {
    const at = post.scheduledFor
      ? escapeHtml(formatScheduleTime(post.scheduledFor, post.scheduledTimezone))
      : 'no time set';
    const who = post.xAuthorUsername ? ` · @${escapeHtml(post.xAuthorUsername)}` : '';
    const where = channels.length > 1 ? ` · 📢 ${escapeHtml(channel.name)}` : '';
    return `🕒 ${at}${who}${where}\n${escapeHtml(post.xPostUrl)}`;
  });

  return [`<b>Scheduled</b> (${posts.length})`, '', lines.join('\n\n')].join('\n');
}

/** Run a source command in one channel, the way it runs for a single-channel reviewer. */
async function runInChannel(
  context: CommandContext,
  command: SourceCommand,
  username: string,
): Promise<CommandReply> {
  const single = { ...context, workspaces: undefined };
  switch (command) {
    case 'addsource':
      return handleAddSource(single, username);
  }
}

/** A source command from a reviewer of several channels: ask which, with a button per channel. */
async function sourceCommandAcrossChannels(
  context: CommandContext,
  command: SourceCommand,
  args: string,
  channels: WorkspaceRef[],
): Promise<CommandReply> {
  const resolved = await resolveHandleArgument(args, `/${command} @username`);
  if (!resolved.ok) return { text: resolved.reply };
  const { username } = resolved;

  return {
    text: CHOICE_QUESTIONS[command](escapeHtml(username)),
    replyMarkup: {
      inline_keyboard: channels.map((channel) => [
        {
          text: `📢 ${channel.name}`,
          callback_data: buildChannelChoiceData(command, channel.id, username),
        },
      ]),
    },
  };
}

/**
 * Carry out a source command in the channel the reviewer picked. The channel
 * must be one of theirs: a button for any other is refused like a stranger's.
 */
export async function runChosenChannel(
  context: CommandContext,
  choice: { command: SourceCommand; workspaceId: number; username: string },
): Promise<CommandReply> {
  const channel = channelsOf(context).find((candidate) => candidate.id === choice.workspaceId);
  if (!channel) return { text: '⚠️ That channel is not one of yours.' };

  const reply = await runInChannel(
    { ...context, workspaceId: channel.id },
    choice.command,
    choice.username,
  );

  // Say which channel it happened in, when there are several it could have been.
  return channelsOf(context).length > 1
    ? { ...reply, text: `📢 ${escapeHtml(channel.name)}\n\n${reply.text}` }
    : reply;
}

/**
 * Dispatch a command. Returns null for anything unrecognised, so the webhook
 * can stay silent rather than arguing with stray messages.
 */
export async function dispatchCommand(
  context: CommandContext,
  parsed: ParsedCommand,
): Promise<CommandReply | null> {
  const { command } = parsed;
  const channels = channelsOf(context);

  if (MOVED_TO_STATS.has(command)) {
    return {
      text: 'Your sources, their numbers and the buttons to pause, resume or remove them are in /sourcestats.',
      offerStats: true,
      offerSettings: true,
    };
  }

  switch (command) {
    case 'start':
    case 'help':
      return { text: HELP_TEXT };
    case 'scheduled':
      return { text: await handleScheduled(context) };
    case 'sourcestats':
      return {
        text:
          '<b>Source stats</b>\n\nPer source: posts it brought in, how many you approved and why the rest ' +
          'were rejected, and roughly what reading them from X cost — with buttons to pause, resume or ' +
          'remove each. ⚙️ Settings has the per-source options.',
        offerStats: true,
        offerSettings: true,
      };
    case 'addsource':
      return channels.length > 1
        ? sourceCommandAcrossChannels(context, command, parsed.args, channels)
        : runInChannel(context, command, parsed.args);
    default:
      return null;
  }
}

export { HELP_TEXT, updateSourceUsername };
