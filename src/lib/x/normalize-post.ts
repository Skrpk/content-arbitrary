import type { Mp4Variant, NormalizedMedia, NormalizedPost } from '@/types';
import type { XMedia, XPost, XUrlEntity } from '@/lib/x/schemas';

/**
 * Turns a raw X post + the response's `includes.media` into the minimal shape
 * the publisher needs, and cleans up the text along the way.
 */

/**
 * X appends a t.co link to the post text pointing at the post's own media
 * (rendered as `pic.x.com/…`). It is meaningless once the media is attached to
 * the Telegram message, so we strip it — but we must keep links the author
 * genuinely wrote.
 */
export function isSelfMediaUrlEntity(entity: XUrlEntity): boolean {
  if (entity.media_key) return true;

  const display = entity.display_url ?? '';
  if (/^pic\.(x|twitter)\.com\//i.test(display)) return true;

  const expanded = entity.expanded_url ?? '';
  return /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+\/(?:photo|video)\/\d+/i.test(
    expanded,
  );
}

/**
 * Replace t.co shorteners with the URL the author actually linked, and drop the
 * trailing self-media link.
 *
 * We match on the literal t.co string rather than using the entity `start`/`end`
 * offsets on purpose: those offsets are expressed in Unicode code points, while
 * JavaScript strings are indexed in UTF-16 code units. Slicing by them corrupts
 * any post containing emoji or other astral-plane characters.
 */
export function cleanPostText(text: string, urlEntities: XUrlEntity[] = []): string {
  let output = text;

  for (const entity of urlEntities) {
    if (!entity.url) continue;

    const replacement = isSelfMediaUrlEntity(entity) ? '' : entity.expanded_url ?? entity.url;
    output = output.split(entity.url).join(replacement);
  }

  // X HTML-escapes these three characters in `text`; restore them so the caption
  // reads correctly (and so our own HTML escaping is applied exactly once).
  output = output.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

  // Collapse the whitespace left behind by removed links, without flattening
  // the author's intentional paragraph breaks.
  return output
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Every progressive MP4 rendition, highest bitrate first.
 *
 * X encodes each video at several bitrates. Keeping the whole list lets the
 * publisher fall back to a smaller rendition instead of giving up when the
 * best one is above Telegram's upload limit.
 */
export function listMp4Variants(media: XMedia): Mp4Variant[] {
  return (media.variants ?? [])
    .filter(
      (variant) =>
        variant.url !== undefined &&
        variant.content_type !== undefined &&
        variant.content_type.toLowerCase() === 'video/mp4',
    )
    .map((variant) => ({
      url: variant.url!,
      bitRate: variant.bit_rate,
      contentType: variant.content_type!,
    }))
    .sort((a, b) => (b.bitRate ?? 0) - (a.bitRate ?? 0));
}

/**
 * Pick the best MP4 rendition of a video.
 *
 * X returns both HLS (`application/x-mpegURL`) and progressive MP4 variants.
 * Telegram cannot ingest an HLS playlist, so we take the highest-bitrate MP4
 * and treat "no MP4 available" as an explicit, reportable condition.
 */
export function selectBestVideoVariant(
  media: XMedia,
): { url: string; bitRate?: number; contentType: string } | null {
  const mp4Variants = (media.variants ?? []).filter(
    (variant) =>
      variant.url !== undefined &&
      variant.content_type !== undefined &&
      variant.content_type.toLowerCase() === 'video/mp4',
  );

  if (mp4Variants.length === 0) return null;

  const best = mp4Variants.reduce((winner, candidate) =>
    (candidate.bit_rate ?? 0) > (winner.bit_rate ?? 0) ? candidate : winner,
  );

  return {
    url: best.url!,
    bitRate: best.bit_rate,
    contentType: best.content_type!,
  };
}

/**
 * Build the media list for a post.
 *
 * De-duplicates on `media_key` so the same asset is never uploaded twice, and
 * preserves the author's ordering, which is what the album should reflect.
 */
export function extractMedia(post: XPost, mediaByKey: Map<string, XMedia>): {
  media: NormalizedMedia[];
  unsupported: string[];
} {
  const media: NormalizedMedia[] = [];
  const unsupported: string[] = [];
  const seen = new Set<string>();

  for (const key of post.attachments?.media_keys ?? []) {
    if (seen.has(key)) continue;
    seen.add(key);

    const item = mediaByKey.get(key);
    if (!item) {
      unsupported.push(`${key}: not present in includes.media`);
      continue;
    }

    if (item.type === 'photo') {
      if (!item.url) {
        unsupported.push(`${key}: photo has no url`);
        continue;
      }
      media.push({
        mediaKey: key,
        kind: 'photo',
        url: item.url,
        width: item.width,
        height: item.height,
      });
      continue;
    }

    if (item.type === 'video' || item.type === 'animated_gif') {
      const variant = selectBestVideoVariant(item);
      if (!variant) {
        unsupported.push(`${key}: no progressive MP4 variant (HLS only)`);
        continue;
      }
      media.push({
        mediaKey: key,
        kind: 'video',
        url: variant.url,
        mp4Variants: listMp4Variants(item),
        width: item.width,
        height: item.height,
        durationSeconds: item.duration_ms ? Math.round(item.duration_ms / 1000) : undefined,
        bitRate: variant.bitRate,
        contentType: variant.contentType,
        wasAnimatedGif: item.type === 'animated_gif',
      });
      continue;
    }

    unsupported.push(`${key}: unsupported media type "${item.type}"`);
  }

  return { media, unsupported };
}

export function normalizePost(
  post: XPost,
  mediaByKey: Map<string, XMedia>,
  authorUsername: string,
): { post: NormalizedPost; unsupported: string[] } {
  const referenced = post.referenced_tweets ?? [];
  const { media, unsupported } = extractMedia(post, mediaByKey);

  return {
    post: {
      id: post.id,
      url: `https://x.com/${authorUsername}/status/${post.id}`,
      authorUsername,
      createdAt: post.created_at ? new Date(post.created_at) : null,
      text: cleanPostText(post.text, post.entities?.urls ?? []),
      media,
      isReply:
        referenced.some((reference) => reference.type === 'replied_to') ||
        post.in_reply_to_user_id !== undefined,
      isRepost: referenced.some((reference) => reference.type === 'retweeted'),
      isQuote: referenced.some((reference) => reference.type === 'quoted'),
    },
    unsupported,
  };
}
