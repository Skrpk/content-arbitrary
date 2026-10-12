/**
 * A public Telegram channel's username, from however it was pasted.
 *
 * Accepts `durov`, `@durov`, `t.me/durov`, `https://t.me/s/durov`, a link to
 * one of its posts, or the same on telegram.me — and returns the bare
 * username, lower-cased: Telegram usernames are case-insensitive, so this is
 * what tells two sources apart.
 *
 * Invite links (`t.me/+…`, `t.me/joinchat/…`) are turned away with their own
 * reason: they lead to private channels, which have no public page to read.
 * The pattern is deliberately a little looser than the one Telegram enforces
 * for new names (collectible names are shorter); whether the channel exists
 * is settled by fetching its page.
 */

const USERNAME_PATTERN = /^[a-z][a-z0-9_]{2,31}$/;

/** Paths on t.me that are site features, not channels. */
const RESERVED = new Set(['s', 'share', 'addstickers', 'addemoji', 'addtheme', 'proxy', 'socks', 'setlanguage', 'login', 'iv', 'k', 'a', 'z']);

export type ChannelUsernameResult =
  | { ok: true; username: string }
  | { ok: false; reason: 'empty' | 'invalid' | 'private' };

export function normalizeChannelUsername(input: string): ChannelUsernameResult {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };

  let candidate = trimmed;
  const link = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(.*)$/i.exec(candidate);
  if (link) {
    const path = link[1]!.split(/[?#]/)[0]!.split('/').filter(Boolean);
    if (path[0] === 's') path.shift();
    candidate = path[0] ?? '';
    if (candidate.startsWith('+') || candidate.toLowerCase() === 'joinchat') return { ok: false, reason: 'private' };
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    // A link to somewhere else entirely; never a channel.
    return { ok: false, reason: 'invalid' };
  }

  candidate = candidate.replace(/^@/, '').toLowerCase();
  if (candidate === '') return { ok: false, reason: 'empty' };
  if (!USERNAME_PATTERN.test(candidate) || candidate.endsWith('_') || RESERVED.has(candidate)) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, username: candidate };
}

/**
 * Whether what was typed into the "add a source" field means a Telegram
 * channel rather than a feed URL: a t.me link, or an `@username`.
 */
export function looksLikeTelegramChannel(input: string): boolean {
  const trimmed = input.trim();
  return /^@/.test(trimmed) || /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\//i.test(trimmed);
}

/** The channel's own page, as people open it. */
export function channelUrl(username: string): string {
  return `https://t.me/${username}`;
}
