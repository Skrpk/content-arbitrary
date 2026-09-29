/**
 * Turning whatever the admin typed into a bare X handle.
 *
 * People paste links, copy handles with the `@`, and occasionally include a
 * trailing slash or tracking query. All of those mean the same account, so they
 * are normalised here rather than in the command handler.
 */

/** X handles: 1-15 characters, letters, digits and underscore only. */
const HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

/**
 * Paths on x.com that are site features rather than profiles. Pasting one of
 * these is a mistake worth catching, since `i` or `home` would otherwise be
 * accepted as a perfectly valid-looking handle.
 */
const RESERVED_HANDLES = new Set([
  'home',
  'explore',
  'notifications',
  'messages',
  'settings',
  'search',
  'compose',
  'i',
  'intent',
  'share',
  'login',
  'logout',
  'signup',
  'tos',
  'privacy',
]);

export type NormalizeResult =
  | { ok: true; username: string }
  | { ok: false; reason: 'empty' | 'invalid' | 'reserved' };

/**
 * Accepts `karpathy`, `@karpathy`, `x.com/karpathy`, a full profile URL, or a
 * link to a specific post, and returns the handle in its bare form.
 */
export function normalizeXUsername(input: string): NormalizeResult {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };

  let candidate = trimmed;

  // A URL (with or without a scheme) — take the first path segment.
  const urlMatch =
    /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:#!\/)?([^/?#\s]+)/i.exec(candidate);
  if (urlMatch) {
    candidate = urlMatch[1]!;
  } else if (/^(?:https?:\/\/)/i.test(candidate)) {
    // A link to somewhere else entirely; never a handle.
    return { ok: false, reason: 'invalid' };
  }

  candidate = candidate.replace(/^@+/, '').replace(/\/+$/, '').trim();

  if (candidate === '') return { ok: false, reason: 'empty' };
  if (!HANDLE_PATTERN.test(candidate)) return { ok: false, reason: 'invalid' };
  if (RESERVED_HANDLES.has(candidate.toLowerCase())) return { ok: false, reason: 'reserved' };

  return { ok: true, username: candidate };
}
