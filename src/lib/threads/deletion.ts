import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The confirmation code Meta's data deletion callback answers with, and the
 * status page it leads to. The deletion happens in the callback itself, so
 * every code that was ever handed out stands for one that is done: the code
 * is when it happened, signed, and nothing about whom it was for is kept.
 */

export function deletionConfirmationCode(appSecret: string, at = new Date()): string {
  const time = at.getTime().toString(36);
  return `${time}${sign(appSecret, time)}`;
}

/** When the deletion this code confirms happened, or null for a code we never gave. */
export function deletionConfirmedAt(code: string | null, appSecret: string): Date | null {
  if (!code || !/^[0-9a-z]{6,12}$/.test(code.slice(0, -SIGNATURE_LENGTH)) || code.length > 40) return null;
  const time = code.slice(0, -SIGNATURE_LENGTH);
  const given = Buffer.from(code.slice(-SIGNATURE_LENGTH));
  const expected = Buffer.from(sign(appSecret, time));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const at = new Date(parseInt(time, 36));
  return Number.isNaN(at.getTime()) ? null : at;
}

const SIGNATURE_LENGTH = 20;

function sign(appSecret: string, time: string): string {
  return createHmac('sha256', appSecret).update(`threads-deletion:${time}`).digest('hex').slice(0, SIGNATURE_LENGTH);
}
