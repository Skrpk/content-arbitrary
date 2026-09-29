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

/**
 * Whether a Telegram user may manage sources.
 *
 * Named and exported so the rule is stated once and can be tested directly,
 * rather than being an inline comparison inside the webhook.
 */
export function isAuthorizedAdmin(
  fromId: number | string | undefined,
  adminChatId: string | undefined,
): boolean {
  if (fromId === undefined || !adminChatId) return false;
  return String(fromId) === adminChatId;
}

export interface CommandContext {
  db: Database;
  xClient: XClient;
  logger: Logger;
}

const HELP_TEXT = [
  '<b>Source management</b>',
  '',
  '/sources — list every source',
  '/addsource @username — start watching an account',
  '/removesource @username — stop watching and forget it',
  '/pausesource @username — keep it, but skip it on sync',
  '/resumesource @username — watch it again',
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

export async function handleSources(context: CommandContext): Promise<string> {
  const all = await listSources(context.db);

  if (all.length === 0) {
    return [
      'No sources yet.',
      '',
      'Add the first one:',
      '<code>/addsource @username</code>',
    ].join('\n');
  }

  const lines = all.map(
    (source) => `${source.enabled ? '✅' : '⏸'} @${escapeHtml(source.username)}`,
  );

  const paused = all.filter((source) => !source.enabled).length;
  const footer = paused > 0 ? ['', `${paused} paused — /resumesource to re-enable.`] : [];

  return ['<b>Sources</b>', '', ...lines, ...footer].join('\n');
}

export async function handleAddSource(context: CommandContext, args: string): Promise<string> {
  const resolved = await resolveHandleArgument(args, '/addsource @username');
  if (!resolved.ok) return resolved.reply;

  let user: { id: string; username: string };
  try {
    // The X API is the authority on both existence and the numeric id.
    user = await context.xClient.getUserByUsername(resolved.username);
  } catch (error) {
    context.logger.warn('command.addsource_resolve_failed', {
      username: resolved.username,
      error: describeError(error),
    });
    return (
      `⚠️ Could not find <b>@${escapeHtml(resolved.username)}</b> on X.\n\n` +
      'The account may not exist, or it may be protected or suspended.'
    );
  }

  const result = await addSource(context.db, {
    platform: 'x',
    externalId: user.id,
    username: user.username,
  });

  if (!result.created) {
    const note = result.source.enabled
      ? ''
      : '\n\nIt is currently paused — /resumesource to watch it again.';
    return `ℹ️ <b>@${escapeHtml(user.username)}</b> is already in your sources.${note}`;
  }

  context.logger.info('command.source_added', { username: user.username, externalId: user.id });
  return `✅ <b>Source added</b>\n\n@${escapeHtml(user.username)}`;
}

/** Find a source by handle, preferring an exact match on what X currently reports. */
async function findByHandle(context: CommandContext, username: string) {
  return findSourceByUsername(context.db, { platform: 'x', username });
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

/**
 * Dispatch a command. Returns null for anything unrecognised, so the webhook
 * can stay silent rather than arguing with stray messages.
 */
export async function dispatchCommand(
  context: CommandContext,
  parsed: ParsedCommand,
): Promise<string | null> {
  switch (parsed.command) {
    case 'start':
    case 'help':
      return HELP_TEXT;
    case 'sources':
      return handleSources(context);
    case 'addsource':
      return handleAddSource(context, parsed.args);
    case 'removesource':
    case 'deletesource':
      return handleRemoveSource(context, parsed.args);
    case 'pausesource':
      return setEnabled(context, parsed.args, false);
    case 'resumesource':
      return setEnabled(context, parsed.args, true);
    default:
      return null;
  }
}

export { HELP_TEXT, updateSourceUsername };
