import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ReviewMediaItem } from '@/db/schema';
import { getEnv } from '@/lib/env';
import { TELEGRAM_POST_ID_PREFIX } from '@/lib/sources/display';
import { parseChannelPostId } from '@/lib/telegram-channel/normalize';

/**
 * Where the review pages show a channel post's picture from.
 *
 * The links a channel's page gives out carry a token that runs out, and a
 * post can wait in the queue for days; so a queued Telegram post's picture is
 * shown through /api/media/telegram, which looks the post up again and sends
 * the browser on to the link that works now. That link is signed, so the
 * route only ever looks up posts this app handed out — it is opened by an
 * <img>, which carries no proof of who is asking. Any other platform's
 * picture is shown from where it was stored.
 */

const ROUTE = '/api/media/telegram';

/** The picture to show for a post's media item, by its place in the post. */
export function shownMediaUrl(
  externalId: string,
  index: number,
  item: Pick<ReviewMediaItem, 'kind' | 'url' | 'previewUrl'>,
  secret?: string,
): string | null {
  const stored = (item.kind === 'photo' ? item.url : item.previewUrl) ?? null;
  const post = parseChannelPostId(externalId);
  if (!post || !stored) return stored;
  const ref = `${post.channel}/${post.messageId}`;
  const params = new URLSearchParams({ post: ref, i: String(index), sig: signature(ref, index, secret ?? getEnv().CRON_SECRET) });
  return `${ROUTE}?${params}`;
}

/** The post and item a signed link names, or null when it is not one this app signed. */
export function verifyMediaLink(
  query: URLSearchParams,
  secret: string,
): { channel: string; messageId: number; index: number } | null {
  const ref = query.get('post') ?? '';
  const index = Number(query.get('i'));
  const sig = query.get('sig') ?? '';
  const post = parseChannelPostId(`${TELEGRAM_POST_ID_PREFIX}${ref}`);
  if (!post || !Number.isSafeInteger(index) || index < 0 || index > 99) return null;

  const expected = Buffer.from(signature(ref, index, secret));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return { ...post, index };
}

function signature(ref: string, index: number, secret: string): string {
  // Its own purpose in the key, so the secret's other uses never sign the same message.
  return createHmac('sha256', secret).update(`telegram-media:${ref}:${index}`).digest('base64url');
}
