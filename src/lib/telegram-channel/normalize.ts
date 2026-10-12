import { TELEGRAM_POST_ID_PREFIX } from '@/lib/sources/display';
import type { ChannelPagePost } from '@/lib/telegram-channel/parser';
import type { NormalizedMedia, NormalizedPost } from '@/types';

/**
 * A channel post as a candidate, in the shape the rest of the pipeline —
 * Radar, translation, review, publishing — already takes from X.
 *
 * Its id in `processed_posts.x_post_id` is `tg:<channel>/<message id>`:
 * borrowed X column names, as feed items borrow them (src/lib/rss/identity.ts).
 * The prefix keeps it clear of X's numeric ids and of `rss:`, and since a
 * message id never changes, the UNIQUE (workspace_id, x_post_id) guards
 * against duplicates here too — across the source being removed and added
 * back as well.
 */

export function channelPostId(channel: string, messageId: number): string {
  return `${TELEGRAM_POST_ID_PREFIX}${channel.toLowerCase()}/${messageId}`;
}

/** The channel and message a stored post's id names, or null for one that is not a channel post. */
export function parseChannelPostId(xPostId: string): { channel: string; messageId: number } | null {
  if (!xPostId.startsWith(TELEGRAM_POST_ID_PREFIX)) return null;
  const match = /^([a-z][a-z0-9_]{2,31})\/(\d{1,12})$/.exec(xPostId.slice(TELEGRAM_POST_ID_PREFIX.length));
  return match ? { channel: match[1]!, messageId: Number(match[2]) } : null;
}

export function channelPostToPost(post: ChannelPagePost): NormalizedPost {
  return {
    platform: 'telegram',
    id: channelPostId(post.channel, post.messageId),
    url: post.url,
    // The channel's username: what the source is called everywhere.
    authorUsername: post.channel.toLowerCase(),
    createdAt: post.publishedAt,
    text: post.text,
    media: post.media.map(toMedia),
    isReply: false,
    isRepost: post.forwarded,
    isQuote: false,
    // Views are all the page counts; X's other numbers have no equivalent there.
    metrics:
      post.views === null
        ? null
        : { likes: null, reposts: null, replies: null, quotes: null, bookmarks: null, impressions: post.views },
  };
}

function toMedia(media: ChannelPagePost['media'][number]): NormalizedMedia {
  return {
    mediaKey: `${TELEGRAM_POST_ID_PREFIX}${media.key}`,
    kind: media.kind,
    url: media.url,
    ...(media.kind === 'video' ? { contentType: 'video/mp4' } : {}),
    ...(media.previewUrl ? { previewUrl: media.previewUrl } : {}),
    ...(media.durationSeconds !== undefined ? { durationSeconds: media.durationSeconds } : {}),
  };
}

/** Oldest first, so the channel reads in order: message ids only ever grow. */
export function byMessageId(a: ChannelPagePost, b: ChannelPagePost): number {
  return a.messageId - b.messageId;
}
