import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { exchangeCode, exchangeForLongLived, refreshLongLived, threadsMe, ThreadsApiError } from '@/lib/threads/client';
import { threadsApp, type ThreadsApp } from '@/lib/threads/config';
import { deletionConfirmationCode, deletionConfirmedAt } from '@/lib/threads/deletion';
import { threadsUserFromSignedRequest } from '@/lib/threads/signed-request';
import { decryptToken, encryptToken } from '@/lib/threads/token-crypto';

/** The parts of connecting Threads that need no database: tokens at rest, Meta's signatures, and its API's answers. */

const SECRET = 'threads-app-secret-for-tests-0123456789';
const app: ThreadsApp = {
  appId: '4645779255666888',
  appSecret: SECRET,
  redirectUri: 'https://app.example.com/api/threads/callback',
  requestProfileDiscovery: false,
};

function signed(payload: Record<string, unknown> | string, secret = SECRET): string {
  const body = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)).toString('base64url');
  return `${createHmac('sha256', secret).update(body).digest('base64url')}.${body}`;
}

describe('a Threads token at rest', () => {
  it('comes back as it went in, and is not readable as stored', () => {
    const stored = encryptToken('THQVJtoken-value', SECRET);
    expect(stored).not.toContain('THQVJ');
    expect(stored.startsWith('v1.')).toBe(true);
    expect(decryptToken(stored, SECRET)).toBe('THQVJtoken-value');
  });

  it('is encrypted afresh each time', () => {
    expect(encryptToken('same', SECRET)).not.toBe(encryptToken('same', SECRET));
  });

  it('cannot be read under another secret, or once altered', () => {
    const stored = encryptToken('THQVJtoken-value', SECRET);
    expect(() => decryptToken(stored, `${SECRET}x`)).toThrow();
    const [version, iv, tag, ciphertext] = stored.split('.');
    const flipped = Buffer.from(ciphertext!, 'base64url');
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decryptToken([version, iv, tag, flipped.toString('base64url')].join('.'), SECRET)).toThrow();
    expect(() => decryptToken('plain-token', SECRET)).toThrow();
  });
});

describe('Meta’s signed request', () => {
  it('names the Threads user, digits intact however long', () => {
    expect(threadsUserFromSignedRequest(signed({ algorithm: 'HMAC-SHA256', user_id: '218471' }), SECRET)).toBe('218471');
    // As a bare JSON number this would lose digits.
    expect(threadsUserFromSignedRequest(signed('{"algorithm":"HMAC-SHA256","user_id":17841405793187218}'), SECRET)).toBe('17841405793187218');
  });

  it('is refused when signed with another secret, altered, or malformed', () => {
    expect(threadsUserFromSignedRequest(signed({ algorithm: 'HMAC-SHA256', user_id: '1' }, 'other-secret'), SECRET)).toBeNull();
    const good = signed({ algorithm: 'HMAC-SHA256', user_id: '1' });
    const forged = `${good.split('.')[0]}.${Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '2' })).toString('base64url')}`;
    expect(threadsUserFromSignedRequest(forged, SECRET)).toBeNull();
    expect(threadsUserFromSignedRequest(signed({ algorithm: 'none', user_id: '1' }), SECRET)).toBeNull();
    expect(threadsUserFromSignedRequest(signed({ algorithm: 'HMAC-SHA256' }), SECRET)).toBeNull();
    expect(threadsUserFromSignedRequest('not-a-signed-request', SECRET)).toBeNull();
    expect(threadsUserFromSignedRequest(null, SECRET)).toBeNull();
  });
});

describe('a data deletion’s confirmation code', () => {
  it('is alphanumeric, and confirms when it was', () => {
    const at = new Date('2026-11-09T10:00:00Z');
    const code = deletionConfirmationCode(SECRET, at);
    expect(code).toMatch(/^[0-9a-z]+$/);
    expect(deletionConfirmedAt(code, SECRET)).toEqual(at);
  });

  it('is not one we gave when made up or altered', () => {
    const code = deletionConfirmationCode(SECRET);
    expect(deletionConfirmedAt(`${code.slice(0, -1)}${code.endsWith('0') ? '1' : '0'}`, SECRET)).toBeNull();
    expect(deletionConfirmedAt(deletionConfirmationCode('another-secret-0123456789'), SECRET)).toBeNull();
    expect(deletionConfirmedAt('abc', SECRET)).toBeNull();
    expect(deletionConfirmedAt(null, SECRET)).toBeNull();
  });
});

describe('the Threads app', () => {
  it('is there only with an app ID, its secret and a website to come back to', () => {
    const env = { THREADS_APP_ID: '4645779255666888', THREADS_APP_SECRET: SECRET, WEB_APP_URL: 'https://app.example.com' };
    expect(threadsApp(env)).toEqual(app);
    expect(threadsApp({ ...env, THREADS_APP_SECRET: undefined })).toBeNull();
    expect(threadsApp({ ...env, WEB_APP_URL: undefined })).toBeNull();
  });
});

describe('the Threads API', () => {
  const answering = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch &
      ReturnType<typeof vi.fn>;

  it('exchanges a code with the app’s credentials and the registered redirect', async () => {
    const fetchImpl = answering({ access_token: 'short', token_type: 'bearer', user_id: 17841405793187218 });
    expect(await exchangeCode(app, 'AQBx', { fetchImpl })).toBe('short');
    const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://graph.threads.com/oauth/access_token');
    expect(init.method).toBe('POST');
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      client_id: app.appId,
      client_secret: SECRET,
      code: 'AQBx',
      grant_type: 'authorization_code',
      redirect_uri: app.redirectUri,
    });
  });

  it('gets and refreshes a long-lived token, with its lifetime', async () => {
    const exchange = answering({ access_token: 'long', token_type: 'bearer', expires_in: 5183944 });
    expect(await exchangeForLongLived(app, 'short', { fetchImpl: exchange })).toEqual({ accessToken: 'long', expiresIn: 5183944 });
    expect(String(exchange.mock.calls[0]![0])).toMatch(/^https:\/\/graph\.threads\.com\/access_token\?grant_type=th_exchange_token&/);

    const refresh = answering({ access_token: 'longer', token_type: 'bearer', expires_in: 5183944 });
    expect(await refreshLongLived('long', { fetchImpl: refresh })).toEqual({ accessToken: 'longer', expiresIn: 5183944 });
    expect(String(refresh.mock.calls[0]![0])).toMatch(/^https:\/\/graph\.threads\.com\/refresh_access_token\?grant_type=th_refresh_token&/);
  });

  it('reads who the token belongs to, id as text', async () => {
    const fetchImpl = answering({ id: '17841405793187218', username: 'zmistik' });
    expect(await threadsMe('long', { fetchImpl })).toEqual({ id: '17841405793187218', username: 'zmistik' });
  });

  it('says what Threads said went wrong, and never the token', async () => {
    const fetchImpl = answering({ error_type: 'OAuthException', code: 400, error_message: 'Matching code was not found or was already used' }, 400);
    const error = await exchangeCode(app, 'AQBx', { fetchImpl }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ThreadsApiError);
    expect((error as Error).message).toContain('Matching code was not found');
    expect((error as Error).message).not.toContain(SECRET);

    const graphError = answering({ error: { message: 'Error validating access token', type: 'OAuthException' } }, 401);
    await expect(threadsMe('secret-token', { fetchImpl: graphError })).rejects.toThrow(/Error validating access token/);
    await expect(threadsMe('secret-token', { fetchImpl: graphError })).rejects.not.toThrow(/secret-token/);
  });
});
