import type { Database } from '@/lib/db';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { escapeHtml } from '@/lib/telegram/format-caption';
import { normalizeXUsername } from '@/lib/sources/normalize';
import {
  addSource,
  deleteSource,
  findSourceByUsername,
  listSources,
  setSourceEnabled,
  updateSourceUsername,
} from '@/lib/sources/repository';
import type { XClient } from '@/lib/x/client';
import { formatScheduleTime } from '@/lib/sync/approval';
import { listScheduledPosts } from '@/lib/sync/repository';

/**
 * Slash commands for managing the source list from the bot's private chat.
 *
 * Deliberately stateless: every command carries its own argument, so there is
 * no half-finished conversation to remember between webhook calls — which
 * matters on a serverless runtime where nothing survives an invocation.
 *
 * Handlers return the reply text. Authorisation is the caller's job, so that
 * the single admin check in the webhook stays the only one.
 */

export interface CommandReply {
  text: string;
  /**
   * The reply concerns sources that exist, so it should carry the button that
   * opens their settings. The webhook adds it when a Mini App is configured.
   */
  offerSettings?: boolean;
}

/** Absolute URL of the Mini App page with every source's settings. */
export function buildSettingsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/settings`;
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
}

const HELP_TEXT = [
  '<b>Source management</b>',
  '',
  '/sources — list every source',
  '/addsource @username — start watching an account',
  '/removesource @username — stop watching and forget it',
  '/pausesource @username — keep it, but skip it on sync',
  '/resumesource @username — watch it again',
  '',
  '<b>Publishing</b>',
  '',
  '/scheduled — posts waiting to be published at a set time',
  '',
  'Per-source options, such as mirroring posts without media, are under ⚙️ Settings in /sources.',
].join('\n');

/** Shared argument handling for the four commands that take a handle. */
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

export async function handleSources(context: CommandContext): Promise<CommandReply> {
  const all = await listSources(context.db, context.workspaceId);

  if (all.length === 0) {
    return { text: [
      'No sources yet.',
      '',
      'Add the first one:',
      '<code>/addsource @username</code>',
    ].join('\n') };
  }

  const lines = all.map(
    (source) =>
      `${source.enabled ? '✅' : '⏸'} @${escapeHtml(source.username)}` +
      (source.includeTextOnly ? ' · text posts too' : ''),
  );

  const paused = all.filter((source) => !source.enabled).length;
  const footer = paused > 0 ? ['', `${paused} paused — /resumesource to re-enable.`] : [];

  return { text: ['<b>Sources</b>', '', ...lines, ...footer].join('\n'), offerSettings: true };
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
      : '\n\nIt is currently paused — /resumesource to watch it again.';
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

/** Find a source by handle, preferring an exact match on what X currently reports. */
async function findByHandle(context: CommandContext, username: string) {
  return findSourceByUsername(context.db, {
    platform: 'x',
    username,
    workspaceId: context.workspaceId,
  });
}

export async function handleRemoveSource(context: CommandContext, args: string): Promise<string> {
  const resolved = await resolveHandleArgument(args, '/removesource @username');
  if (!resolved.ok) return resolved.reply;

  const source = await findByHandle(context, resolved.username);
  if (!source) return `ℹ️ <b>@${escapeHtml(resolved.username)}</b> is not in your sources.`;

  await deleteSource(context.db, source.id);
  context.logger.info('command.source_removed', { username: source.username, id: source.id });

  return `🗑 <b>Removed</b>\n\n@${escapeHtml(source.username)} will no longer be synced.`;
}

async function setEnabled(
  context: CommandContext,
  args: string,
  enabled: boolean,
): Promise<string> {
  const usage = enabled ? '/resumesource @username' : '/pausesource @username';
  const resolved = await resolveHandleArgument(args, usage);
  if (!resolved.ok) return resolved.reply;

  const source = await findByHandle(context, resolved.username);
  if (!source) return `ℹ️ <b>@${escapeHtml(resolved.username)}</b> is not in your sources.`;

  if (source.enabled === enabled) {
    return `ℹ️ <b>@${escapeHtml(source.username)}</b> is already ${enabled ? 'active' : 'paused'}.`;
  }

  await setSourceEnabled(context.db, { id: source.id, enabled });
  context.logger.info('command.source_enabled_changed', { username: source.username, enabled });

  return enabled
    ? `▶️ <b>@${escapeHtml(source.username)}</b> resumed.`
    : `⏸ <b>@${escapeHtml(source.username)}</b> paused — kept, but skipped on sync.`;
}

/** The tenant's scheduled posts, soonest first, each at the time it was picked in. */
export async function handleScheduled(context: CommandContext): Promise<string> {
  const posts = await listScheduledPosts(context.db, context.workspaceId);

  if (posts.length === 0) {
    return 'Nothing scheduled. Use 🕒 Schedule under a post in review.';
  }

  const lines = posts.map((post) => {
    const at = post.scheduledFor
      ? escapeHtml(formatScheduleTime(post.scheduledFor, post.scheduledTimezone))
      : 'no time set';
    const who = post.xAuthorUsername ? ` · @${escapeHtml(post.xAuthorUsername)}` : '';
    return `🕒 ${at}${who}\n${escapeHtml(post.xPostUrl)}`;
  });

  return [`<b>Scheduled</b> (${posts.length})`, '', lines.join('\n\n')].join('\n');
}

/**
 * Dispatch a command. Returns null for anything unrecognised, so the webhook
 * can stay silent rather than arguing with stray messages.
 */
export async function dispatchCommand(
  context: CommandContext,
  parsed: ParsedCommand,
): Promise<CommandReply | null> {
  switch (parsed.command) {
    case 'start':
    case 'help':
      return { text: HELP_TEXT };
    case 'sources':
      return handleSources(context);
    case 'addsource':
      return handleAddSource(context, parsed.args);
    case 'removesource':
    case 'deletesource':
      return { text: await handleRemoveSource(context, parsed.args) };
    case 'pausesource':
      return { text: await setEnabled(context, parsed.args, false) };
    case 'resumesource':
      return { text: await setEnabled(context, parsed.args, true) };
    case 'scheduled':
      return { text: await handleScheduled(context) };
    default:
      return null;
  }
}

export { HELP_TEXT, updateSourceUsername };
