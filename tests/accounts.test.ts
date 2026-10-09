import { describe, expect, it } from 'vitest';
import { clearedCookieHeader, cookieHeader, hashToken, readCookie, randomToken } from '@/lib/accounts/sessions';
import { telegramAccountFromClaims, telegramLoginProvider } from '@/lib/accounts/telegram';
import { sameOrigin } from '@/lib/accounts/viewer';
import { safeReturnTo } from '@/lib/accounts/web';

describe('where a sign-in may send someone afterwards', () => {
  it('is a plain path on the website', () => {
    expect(safeReturnTo('/queue')).toBe('/queue');
    expect(safeReturnTo('/queue?workspace=2')).toBe('/queue?workspace=2');
  });

  it('is never another site, however it is dressed up', () => {
    for (const value of ['https://evil.example', '//evil.example', '/\\evil.example', 'queue', '/a\\b', '/\nx', '', null]) {
      expect(safeReturnTo(value)).toBeNull();
    }
    expect(safeReturnTo(`/${'a'.repeat(400)}`)).toBeNull();
  });
});

describe('the session cookie', () => {
  it('is httpOnly, HTTPS only and this host only', () => {
    const header = cookieHeader('__Host-session', 'abc', new Date('2026-11-01T00:00:00Z'));
    expect(header).toBe(
      '__Host-session=abc; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=Sun, 01 Nov 2026 00:00:00 GMT',
    );
    expect(clearedCookieHeader('__Host-session')).toContain('Max-Age=0');
  });

  it('is read back from the Cookie header by its exact name', () => {
    expect(readCookie('a=1; __Host-session=tok; b=2', '__Host-session')).toBe('tok');
    expect(readCookie('x__Host-session=no', '__Host-session')).toBeNull();
    expect(readCookie(null, '__Host-session')).toBeNull();
  });

  it('is random, and stored only as its hash', () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(token);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toContain(token);
  });
});

describe('a change sent with the session cookie', () => {
  const request = (origin?: string) =>
    new Request('https://app.example.com/api/telegram/webapp/queue', {
      method: 'POST',
      headers: origin ? { origin } : {},
    });

  it('counts only from the website itself', () => {
    expect(sameOrigin(request('https://app.example.com'), 'https://app.example.com')).toBe(true);
    expect(sameOrigin(request('https://evil.example'), 'https://app.example.com')).toBe(false);
    expect(sameOrigin(request(), 'https://app.example.com')).toBe(false);
  });

  it('counts by the Host the browser sent, where the runtime rewrote the URL', () => {
    const rewritten = new Request('http://localhost:3000/api/telegram/webapp/queue', {
      method: 'POST',
      headers: { origin: 'http://app.localhost:3000', host: 'app.localhost:3000' },
    });
    expect(sameOrigin(rewritten, undefined)).toBe(true);
    expect(sameOrigin(new Request(rewritten, { headers: { origin: 'http://evil.localhost:3000', host: 'app.localhost:3000' } }), undefined)).toBe(false);
  });
});

describe('Telegram sign-in', () => {
  it('is set up only with both the Client ID and the Secret', () => {
    expect(telegramLoginProvider({ TELEGRAM_OIDC_CLIENT_ID: '123', TELEGRAM_OIDC_CLIENT_SECRET: 's' })).toMatchObject({
      issuer: 'https://oauth.telegram.org',
      clientId: '123',
      scopes: ['openid', 'profile'],
    });
    expect(telegramLoginProvider({ TELEGRAM_OIDC_CLIENT_ID: '123', TELEGRAM_OIDC_CLIENT_SECRET: undefined })).toBeNull();
  });

  it('knows the person by their Telegram user id, not the OIDC subject', () => {
    expect(
      telegramAccountFromClaims({ sub: '1234123412341234123', id: 555001, name: 'Vita', preferred_username: 'vita' }),
    ).toEqual({ id: '555001', name: 'Vita', username: 'vita' });
    expect(() => telegramAccountFromClaims({ sub: '1234' })).toThrow(/no Telegram user id/);
  });
});
