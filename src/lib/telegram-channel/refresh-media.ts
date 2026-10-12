import { ChannelPageError } from '@/lib/errors';
import { fetchChannelPost } from '@/lib/telegram-channel/client';
import { channelPostToPost, parseChannelPostId } from '@/lib/telegram-channel/normalize';
import type { NormalizedMedia } from '@/types';

/**
 * A queued channel post's media, with links that work now.
 *
 * The links a channel's page gives out carry a token, and a post can wait in
 * the review queue for days; so before a queued post is published its
 * media are looked up again on the post's own page, item by item. A post the
 * channel has since deleted, or one that lost an item, fails here — as an X
 * post deleted meanwhile does — and stays undecided. Media of any other
 * platform are returned as they are.
 */
export async function refreshChannelMedia(
  xPostId: string,
  media: NormalizedMedia[],
  options: { fetchImpl?: typeof fetch } = {},
): Promise<NormalizedMedia[]> {
  const id = parseChannelPostId(xPostId);
  if (!id || media.length === 0) return media;

  const page = await fetchChannelPost(id.channel, id.messageId, { fetchImpl: options.fetchImpl });
  if (!page) {
    throw new ChannelPageError('The post is no longer in its Telegram channel', {
      transient: false,
      code: 'channel_post_gone',
    });
  }

  const fresh = new Map(channelPostToPost(page).media.map((item) => [item.mediaKey, item]));
  return media.map((item) => {
    const now = fresh.get(item.mediaKey);
    if (!now) {
      throw new ChannelPageError('A photo or video of the post is no longer in its Telegram channel', {
        transient: false,
        code: 'channel_media_gone',
      });
    }
    return { ...item, url: now.url, ...(now.previewUrl ? { previewUrl: now.previewUrl } : {}) };
  });
}
