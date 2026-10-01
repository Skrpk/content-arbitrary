import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  initDataFromAuthorizationHeader,
  validateInitData,
  INIT_DATA_MAX_AGE_SECONDS,
} from '@/lib/telegram/webapp-auth';

/**
 * Mini App authentication, against signatures produced the way Telegram
 * documents it:
 *
 *   secret_key = HMAC_SHA256(<bot_token>, key = "WebAppData")
 *   hash       = hex(HMAC_SHA256(data_check_string, key = secret_key))
 *
 * The fixtures below sign independently of the implementation, so a swapped
 * key/message pair — which still produces a plausible digest — cannot pass.
 */

const BOT_TOKEN = '123456:AAHfakeTokenForTestsOnly';

/** Build a signed initData string exactly as Telegram would. */
function signInitData(
  fields: Record<string, string>,
  options?: { token?: string },
): string {
  const token = options?.token ?? BOT_TOKEN;

  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const params = new URLSearchParams(fields);
  params.set('hash', hash);
  return params.toString();
}

function freshFields(overrides: Record<string, string> = {}) {
  return {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAE',
    user: JSON.stringify({ id: 555001, username: 'reviewer', first_name: 'Rev' }),
    ...overrides,
  };
}

describe('initDataFromAuthorizationHeader', () => {
  it('reads the tma scheme', () => {
    expect(initDataFromAuthorizationHeader('tma abc=1&hash=2')).toBe('abc=1&hash=2');
  });

  it('accepts the scheme in any case', () => {
    expect(initDataFromAuthorizationHeader('TMA abc=1')).toBe('abc=1');
  });

  it.each([null, '', 'Bearer abc=1', 'tma', 'tmaabc'])('rejects %p', (header) => {
    expect(initDataFromAuthorizationHeader(header)).toBeNull();
  });
});

describe('validateInitData', () => {
  it('accepts data Telegram signed', () => {
    const result = validateInitData(signInitData(freshFields()), BOT_TOKEN);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.id).toBe(555001);
    expect(result.user.username).toBe('reviewer');
  });

  it('rejects a tampered field', () => {
    // The classic attack: keep the signature, change who you claim to be.
    const signed = signInitData(freshFields());
    const params = new URLSearchParams(signed);
    params.set('user', JSON.stringify({ id: 999999, username: 'attacker' }));

    const result = validateInitData(params.toString(), BOT_TOKEN);
    expect(result).toEqual({ ok: false, reason: 'bad-hash' });
  });

  it('rejects a signature made with another bot token', () => {
    const signed = signInitData(freshFields(), { token: '999:OTHER' });
    expect(validateInitData(signed, BOT_TOKEN)).toEqual({ ok: false, reason: 'bad-hash' });
  });

  it('rejects data with no hash at all', () => {
    const params = new URLSearchParams(freshFields());
    expect(validateInitData(params.toString(), BOT_TOKEN)).toEqual({
      ok: false,
      reason: 'no-hash',
    });
  });

  it.each([null, '', '   '])('rejects %p as missing', (value) => {
    expect(validateInitData(value, BOT_TOKEN)).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejects data older than the maximum age', () => {
    const stale = String(Math.floor(Date.now() / 1000) - INIT_DATA_MAX_AGE_SECONDS - 60);
    const result = validateInitData(signInitData(freshFields({ auth_date: stale })), BOT_TOKEN);

    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('accepts data right at the age limit', () => {
    const now = new Date();
    const authDate = String(Math.floor(now.getTime() / 1000) - INIT_DATA_MAX_AGE_SECONDS + 5);

    const result = validateInitData(signInitData(freshFields({ auth_date: authDate })), BOT_TOKEN, {
      now,
    });
    expect(result.ok).toBe(true);
  });

  it('honours a shorter max age', () => {
    const authDate = String(Math.floor(Date.now() / 1000) - 120);
    const signed = signInitData(freshFields({ auth_date: authDate }));

    expect(validateInitData(signed, BOT_TOKEN, { maxAgeSeconds: 60 })).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(validateInitData(signed, BOT_TOKEN, { maxAgeSeconds: 600 }).ok).toBe(true);
  });

  it('rejects a missing or unparsable auth_date', () => {
    const noDate = signInitData({ query_id: 'AAE', user: JSON.stringify({ id: 1 }) });
    expect(validateInitData(noDate, BOT_TOKEN)).toEqual({ ok: false, reason: 'no-auth-date' });

    const badDate = signInitData(freshFields({ auth_date: 'yesterday' }));
    expect(validateInitData(badDate, BOT_TOKEN)).toEqual({ ok: false, reason: 'no-auth-date' });
  });

  it.each([
    ['absent', undefined],
    ['not json', 'not-json'],
    ['without a numeric id', JSON.stringify({ username: 'nobody' })],
  ])('rejects a user that is %s', (_label, user) => {
    const fields = freshFields();
    if (user === undefined) delete (fields as Record<string, string>).user;
    else fields.user = user;

    const result = validateInitData(signInitData(fields), BOT_TOKEN);
    expect(result).toEqual({ ok: false, reason: 'no-user' });
  });

  /**
   * Telegram signs every field it sends, including ones added after this code
   * was written, so an unknown field must stay in the data-check string. The
   * `signature` field is the live example: dropping it would reject real
   * clients.
   */
  it('verifies data carrying fields it does not know about', () => {
    const signed = signInitData(
      freshFields({ signature: 'abc123', chat_type: 'private', some_future_field: 'x' }),
    );

    expect(validateInitData(signed, BOT_TOKEN).ok).toBe(true);
  });

  it('accepts a hash in upper case', () => {
    const signed = signInitData(freshFields());
    const params = new URLSearchParams(signed);
    params.set('hash', params.get('hash')!.toUpperCase());

    expect(validateInitData(params.toString(), BOT_TOKEN).ok).toBe(true);
  });

  it('rejects a hash of the wrong length without throwing', () => {
    // timingSafeEqual throws on mismatched lengths; the guard must come first.
    const params = new URLSearchParams(freshFields());
    params.set('hash', 'deadbeef');

    expect(validateInitData(params.toString(), BOT_TOKEN)).toEqual({
      ok: false,
      reason: 'bad-hash',
    });
  });
});
