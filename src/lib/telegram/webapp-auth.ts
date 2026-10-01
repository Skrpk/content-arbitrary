import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Authentication for the Mini App.
 *
 * A Mini App is a web page: anyone can open its URL, so the page itself proves
 * nothing. What proves something is `initData`, a query string Telegram hands
 * the page, signed with a key derived from the bot token. Verifying it server
 * side is the only thing that establishes which Telegram user is calling.
 *
 * The algorithm is Telegram's, from core.telegram.org/bots/webapps:
 *
 *   secret_key = HMAC_SHA256(<bot_token>, key = "WebAppData")
 *   hash       = hex(HMAC_SHA256(data_check_string, key = secret_key))
 *
 * where `data_check_string` is every received field except `hash`, sorted
 * alphabetically, joined as `key=value` by a newline. Note which argument is
 * the key in each step — swapping them yields a plausible-looking digest that
 * never matches.
 */

/** How old signed data may be. Telegram recommends checking, not a value. */
export const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;

export interface InitDataUser {
  id: number;
  username?: string;
  firstName?: string;
}

export type InitDataResult =
  | { ok: true; user: InitDataUser; authDate: Date }
  | { ok: false; reason: InitDataFailure };

export type InitDataFailure =
  | 'missing'
  | 'malformed'
  | 'no-hash'
  | 'bad-hash'
  | 'no-auth-date'
  | 'expired'
  | 'no-user';

/** Pull the init data out of an `Authorization: tma <initData>` header. */
export function initDataFromAuthorizationHeader(header: string | null): string | null {
  if (!header) return null;

  const match = /^tma\s+(.+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

export function validateInitData(
  initData: string | null,
  botToken: string,
  options?: { maxAgeSeconds?: number; now?: Date },
): InitDataResult {
  if (!initData || initData.trim() === '') return { ok: false, reason: 'missing' };

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const presentedHash = params.get('hash');
  if (!presentedHash) return { ok: false, reason: 'no-hash' };

  /**
   * Only `hash` comes out. Everything else Telegram sent stays in, including
   * newer fields such as `signature` — the hash was computed over all of them,
   * so dropping one we did not expect would break verification for real
   * clients.
   */
  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secretKey).update(pairs.join('\n')).digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presentedHash.toLowerCase(), 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad-hash' };
  }

  const rawAuthDate = params.get('auth_date');
  const authDateSeconds = rawAuthDate === null ? NaN : Number(rawAuthDate);
  if (!Number.isFinite(authDateSeconds)) return { ok: false, reason: 'no-auth-date' };

  // A valid signature is valid forever, so without this check a captured
  // initData string would stay usable indefinitely.
  const maxAge = options?.maxAgeSeconds ?? INIT_DATA_MAX_AGE_SECONDS;
  const now = options?.now ?? new Date();
  const ageSeconds = now.getTime() / 1000 - authDateSeconds;
  if (ageSeconds > maxAge) return { ok: false, reason: 'expired' };

  const rawUser = params.get('user');
  if (!rawUser) return { ok: false, reason: 'no-user' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawUser);
  } catch {
    return { ok: false, reason: 'no-user' };
  }

  const candidate = parsed as { id?: unknown; username?: unknown; first_name?: unknown };
  if (typeof candidate.id !== 'number' || !Number.isFinite(candidate.id)) {
    return { ok: false, reason: 'no-user' };
  }

  return {
    ok: true,
    authDate: new Date(authDateSeconds * 1000),
    user: {
      id: candidate.id,
      username: typeof candidate.username === 'string' ? candidate.username : undefined,
      firstName: typeof candidate.first_name === 'string' ? candidate.first_name : undefined,
    },
  };
}
