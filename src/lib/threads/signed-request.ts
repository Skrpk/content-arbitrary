import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta's `signed_request`, as its uninstall and data deletion callbacks post
 * it: `<signature>.<payload>`, the payload JSON in base64url and the
 * signature its HMAC-SHA256 under the app secret. Anything not signed so is
 * not from Meta.
 */

const MAX_LENGTH = 4096;

/** The Threads user it names, or null for anything unsigned, altered or malformed. */
export function threadsUserFromSignedRequest(value: string | null | undefined, appSecret: string): string | null {
  if (!value || value.length > MAX_LENGTH) return null;
  const [signature, payload, extra] = value.split('.');
  if (!signature || !payload || extra !== undefined) return null;

  const expected = createHmac('sha256', appSecret).update(payload).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  const text = Buffer.from(payload, 'base64url').toString('utf8');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || String((data as { algorithm?: unknown }).algorithm).toUpperCase() !== 'HMAC-SHA256') {
    return null;
  }
  // Read from the text, not the parsed number: an id this long loses digits as a JavaScript number.
  const match = /"user_id"\s*:\s*"?(\d{1,30})"?/.exec(text);
  return match ? match[1]! : null;
}
