import { put } from '@vercel/blob';
import type { Database } from '@/lib/db';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { postUploads, type ProcessedPost } from '@/db/schema';
import { TELEGRAM_UPLOAD_PHOTO_MAX_BYTES } from '@/lib/telegram/limits';
import { fetchPublic, type WebsiteFetchOptions } from '@/lib/website/http';
import { loadUploads, uploadPathPrefix, type UploadRow } from '@/lib/uploads/uploads';

/**
 * The picture of the article a post links to, made one of its uploads, so the
 * editor starts with it in the post as it does with a tweet's own photo.
 *
 * Only for a post with no media of its own whose source named a picture: a
 * feed entry's (src/lib/rss/parser.ts) or a website page's og:image. It is
 * fetched from the server, with a public address's protections
 * (src/lib/website/http.ts), checked to be a JPEG, PNG or WebP by its bytes,
 * and put in the store under the post's own path, where it is an upload like
 * any other: placed as `u<id>`, sent from the store, deleted once the post is
 * decided. Once per post: the next opening finds it there.
 */

/** Where the article's picture is kept, apart from what the reviewer uploads. */
const ARTICLE_IMAGE_NAME = 'article-image';

/** The store's write, behind what this module does with it — a test replaces it. */
export interface ArticleImageStore {
  put(pathname: string, bytes: Uint8Array, contentType: string): Promise<{ url: string; pathname: string }>;
}

export function vercelArticleImageStore(token?: string): ArticleImageStore {
  return {
    put: async (pathname, bytes, contentType) => {
      const blob = await put(pathname, Buffer.from(bytes), {
        access: 'public',
        contentType,
        addRandomSuffix: false,
        allowOverwrite: true,
        ...(token ? { token } : {}),
      });
      return { url: blob.url, pathname: blob.pathname };
    },
  };
}

/** The article's picture a post's source named, when the post has no media of its own. */
export function articleImageUrl(post: Pick<ProcessedPost, 'sourceMetadata'>): string | null {
  return post.sourceMetadata?.previewImageUrl ?? post.sourceMetadata?.website?.imageUrl ?? null;
}

/** A photo Telegram shows, by its first bytes, whatever the server called it. */
export function sniffPhotoType(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  const at = (index: number) => bytes[index];
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png';
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;

/**
 * The post's article picture as an upload: the one already made, or one made
 * now. Null when there is none to make — the post has media, no picture was
 * named, or it could not be fetched as a photo Telegram takes — which leaves
 * the editor as it was, never in the way of opening it.
 */
export async function articleImageUpload(
  db: Database,
  store: ArticleImageStore,
  input: {
    post: Pick<ProcessedPost, 'id' | 'workspaceId' | 'sourceMetadata'>;
    logger: Logger;
    fetchOptions?: WebsiteFetchOptions;
  },
): Promise<UploadRow | null> {
  const address = articleImageUrl(input.post);
  if (!address) return null;

  const prefix = `${uploadPathPrefix(input.post.id)}${ARTICLE_IMAGE_NAME}.`;
  const existing = (await loadUploads(db, input.post.id)).find((upload) => upload.pathname.startsWith(prefix));
  if (existing) return existing;

  try {
    const fetched = await fetchPublic(address, {
      ...input.fetchOptions,
      accept: 'image/jpeg,image/png,image/webp,image/*;q=0.8',
      maxBytes: TELEGRAM_UPLOAD_PHOTO_MAX_BYTES,
      what: 'article picture',
    });
    const contentType = sniffPhotoType(fetched.bytes);
    if (!contentType) {
      input.logger.info('uploads.article_image_skipped', { postId: input.post.id, reason: 'not a JPEG, PNG or WebP', type: fetched.contentType });
      return null;
    }
    const blob = await store.put(`${prefix}${EXTENSIONS[contentType]}`, fetched.bytes, contentType);
    const [upload] = await db
      .insert(postUploads)
      .values({
        workspaceId: input.post.workspaceId,
        processedPostId: input.post.id,
        kind: 'photo',
        url: blob.url,
        pathname: blob.pathname,
        contentType,
        sizeBytes: fetched.bytes.byteLength,
      })
      .onConflictDoNothing({ target: postUploads.url })
      .returning();
    input.logger.info('uploads.article_image_saved', { postId: input.post.id, bytes: fetched.bytes.byteLength });
    return upload ?? (await loadUploads(db, input.post.id)).find((row) => row.url === blob.url) ?? null;
  } catch (error) {
    input.logger.warn('uploads.article_image_failed', { postId: input.post.id, error: describeError(error) });
    return null;
  }
}
