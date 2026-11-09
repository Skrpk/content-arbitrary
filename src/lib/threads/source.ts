import { THREADS_POST_ID_PREFIX } from '@/lib/sources/display';
import type { ThreadsApiPost } from '@/lib/threads/client';
import type { NormalizedMedia, NormalizedPost } from '@/types';

/**
 * A Threads account as a source, and its posts as candidates in the shape the
 * rest of the pipeline — Radar, translation, review, publishing — already
 * takes from X.
 *
 * A source is stored by its username: Threads' profile reading goes by it,
 * and gives no other id. A post's id in `processed_posts.external_id` is
 * `th:<Threads media id>`, which never changes.
 */

export function threadsPostId(mediaId: string): string {
  return `${THREADS_POST_ID_PREFIX}${mediaId}`;
}

/** The Threads media id a stored post's id names, or null for one that is not a Threads post. */
export function parseThreadsPostId(externalId: string): string | null {
  if (!externalId.startsWith(THREADS_POST_ID_PREFIX)) return null;
  const id = externalId.slice(THREADS_POST_ID_PREFIX.length);
  return /^\d{1,40}$/.test(id) ? id : null;
}

export type ThreadsUsernameCheck = { ok: true; username: string } | { ok: false; reason: 'empty' | 'post' | 'invalid' };

/** A username from what people paste: `@name`, `name`, or a threads.com / threads.net profile link. */
export function normalizeThreadsUsername(input: string): ThreadsUsernameCheck {
  const value = input.trim();
  if (!value) return { ok: false, reason: 'empty' };
  let candidate = value;
  const link = /^(?:https?:\/\/)?(?:www\.)?threads\.(?:com|net)\/(@?[^/?#\s]+)(\/[^?#\s]*)?/i.exec(value);
  if (link) {
    if (link[2] && /\/post\//i.test(link[2])) return { ok: false, reason: 'post' };
    candidate = link[1]!;
  }
  candidate = candidate.replace(/^@/, '').toLowerCase();
  // Instagram's rules, which Threads shares: letters, digits, dots and underscores, up to 30.
  if (!/^[a-z0-9._]{1,30}$/.test(candidate) || candidate.startsWith('.') || candidate.endsWith('.')) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, username: candidate };
}

export function threadsProfileUrl(username: string): string {
  return `https://www.threads.com/@${username}`;
}

/** Why a post is no candidate at all, or null when it is one. */
export function threadsSkipReason(post: ThreadsApiPost, options: { includeTextOnly: boolean; includeQuotes: boolean }): string | null {
  if (post.media_type === 'REPOST_FACADE') return 'a repost';
  if (post.is_quote_post && !options.includeQuotes) return 'a quote';
  const media = threadsMediaOf(post);
  const text = postText(post);
  if (media.length === 0 && (!options.includeTextOnly || text === '')) return text === '' ? 'no media and no text' : 'no media';
  return null;
}

export function threadsPostToPost(post: ThreadsApiPost, sourceUsername: string): NormalizedPost {
  const createdAt = post.timestamp ? new Date(post.timestamp) : null;
  return {
    platform: 'threads',
    id: threadsPostId(post.id),
    url: post.permalink ?? `https://www.threads.com/@${sourceUsername}`,
    authorUsername: (post.username ?? sourceUsername).toLowerCase(),
    createdAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null,
    text: postText(post),
    media: threadsMediaOf(post),
    isReply: false,
    isRepost: post.media_type === 'REPOST_FACADE',
    isQuote: Boolean(post.is_quote_post),
    metrics: null,
  };
}

/** The post's text, with the link it attaches when the text does not already hold it. */
function postText(post: ThreadsApiPost): string {
  const text = (post.text ?? '').trim();
  const link = post.link_attachment_url?.trim();
  return link && /^https?:\/\//i.test(link) && !text.includes(link) ? `${text}\n\n${link}`.trim() : text;
}

/** Its pictures and videos, a carousel's in order; audio and anything else Threads may add are left out. */
export function threadsMediaOf(post: ThreadsApiPost): NormalizedMedia[] {
  const items = post.media_type === 'CAROUSEL_ALBUM' ? (post.children?.data ?? []) : [post];
  return items.flatMap((item, index) => {
    if (!item.media_url) return [];
    const kind = item.media_type === 'IMAGE' ? 'photo' : item.media_type === 'VIDEO' ? 'video' : null;
    if (!kind) return [];
    return [
      {
        mediaKey: `${THREADS_POST_ID_PREFIX}${item.id ?? post.id}:${index}`,
        kind,
        url: item.media_url,
        ...(kind === 'video' ? { contentType: 'video/mp4' } : {}),
        ...(kind === 'video' && item.thumbnail_url ? { previewUrl: item.thumbnail_url } : {}),
      } satisfies NormalizedMedia,
    ];
  });
}
