import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * A Threads access token at rest: AES-256-GCM, with a key derived (HKDF) from
 * the Threads app secret — so a copy of the database alone, a backup, does
 * not hand anyone the tokens. Changing the secret makes every stored token
 * unreadable, and the accounts are connected again.
 *
 * Stored as `v1.<iv>.<tag>.<ciphertext>`, each in base64url.
 */

const VERSION = 'v1';

function keyFrom(appSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', appSecret, 'zmistik', 'threads-access-token v1', 32));
}

export function encryptToken(token: string, appSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(appSecret), iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), ciphertext].map((part) => (typeof part === 'string' ? part : part.toString('base64url'))).join('.');
}

/** The token, or an error for anything altered, truncated or encrypted under another secret. */
export function decryptToken(stored: string, appSecret: string): string {
  const [version, iv, tag, ciphertext] = stored.split('.');
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) throw new Error('not an encrypted Threads token');
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(appSecret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
