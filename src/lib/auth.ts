import { timingSafeEqual } from 'node:crypto';
import { getEnv } from '@/lib/env';

/**
 * Constant-time secret comparison.
 *
 * A naive `===` on a secret leaks its prefix through response timing; this is
 * cheap to do correctly, so we do.
 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Extract a bearer token. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`
 * automatically when CRON_SECRET is set on the project. We also accept
 * `?secret=` so the endpoint can be triggered by hand during setup.
 */
function presentedSecret(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();

  const url = new URL(request.url);
  return url.searchParams.get('secret');
}

export function authorizeCron(request: Request): { ok: true } | { ok: false; reason: string } {
  const env = getEnv();
  const presented = presentedSecret(request);

  if (!presented) return { ok: false, reason: 'missing credentials' };
  if (!safeEqual(presented, env.CRON_SECRET)) return { ok: false, reason: 'invalid credentials' };
  return { ok: true };
}

/** The status endpoint accepts ADMIN_SECRET when set, otherwise CRON_SECRET. */
export function authorizeAdmin(request: Request): { ok: true } | { ok: false; reason: string } {
  const env = getEnv();
  const presented = presentedSecret(request);

  if (!presented) return { ok: false, reason: 'missing credentials' };

  const expected = env.ADMIN_SECRET ?? env.CRON_SECRET;
  if (!safeEqual(presented, expected)) return { ok: false, reason: 'invalid credentials' };
  return { ok: true };
}

export function unauthorized(reason: string): Response {
  return Response.json(
    { ok: false, error: 'Unauthorized', reason },
    { status: 401, headers: { 'cache-control': 'no-store' } },
  );
}
