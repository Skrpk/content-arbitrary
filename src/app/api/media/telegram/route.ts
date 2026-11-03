import { getEnv } from '@/lib/env';
import { describeError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { fetchChannelPost } from '@/lib/telegram-channel/client';
import { verifyMediaLink } from '@/lib/telegram-channel/media-link';
import { channelPostToPost } from '@/lib/telegram-channel/normalize';

/**
 * A queued Telegram post's picture, as its channel has it now: the post's
 * page is looked up again and the browser is sent on to the link it gives
 * (src/lib/telegram-channel/media-link.ts). Only for links this app signed;
 * only to the hosts a channel page's media are taken from, which the parser
 * keeps to; and remembered by the browser for an hour, so a page of the
 * queue does not look every post up each time it is opened.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const BROWSER_CACHE_SECONDS = 60 * 60;

export async function GET(request: Request): Promise<Response> {
  const link = verifyMediaLink(new URL(request.url).searchParams, getEnv().CRON_SECRET);
  if (!link) return new Response('Not found', { status: 404 });

  try {
    const page = await fetchChannelPost(link.channel, link.messageId);
    const item = page ? channelPostToPost(page).media[link.index] : undefined;
    const url = item ? (item.kind === 'photo' ? item.url : item.previewUrl) : undefined;
    if (!url) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    return new Response(null, {
      status: 302,
      headers: { location: url, 'cache-control': `private, max-age=${BROWSER_CACHE_SECONDS}` },
    });
  } catch (error) {
    logger.warn('media.telegram_lookup_failed', { channel: link.channel, messageId: link.messageId, error: describeError(error) });
    return new Response('Unavailable', { status: 502, headers: { 'cache-control': 'no-store' } });
  }
}
