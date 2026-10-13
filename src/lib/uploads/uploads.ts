import { and, asc, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { del, head } from '@vercel/blob';
import type { Database } from '@/lib/db';
import type { Env } from '@/lib/env';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { processedPosts, postUploads, type PostUploadKind } from '@/db/schema';
import { TELEGRAM_UPLOAD_PHOTO_MAX_BYTES } from '@/lib/telegram/limits';
import type { NormalizedMedia } from '@/types';

/**
 * Photos and videos uploaded in the website's editor.
 *
 * The browser sends the file straight to Vercel Blob — past the 4.5 MB a
 * function may be sent — with a token this app hands out for one post
 * (src/app/api/telegram/webapp/uploads), then tells the app it is there; the
 * app checks the file in the store itself before recording it. The editor
 * places it as `u<id>`. Publishing fetches it from the store like any other
 * media, and it is deleted once the post is published or turned down: the
 * store holds a file only while its post waits.
 */

/** What Telegram shows inline in a rich message, by type. */
const UPLOAD_TYPES: Record<string, PostUploadKind> = {
  'image/jpeg': 'photo',
  'image/png': 'photo',
  'image/webp': 'photo',
  'video/mp4': 'video',
};
export const UPLOAD_CONTENT_TYPES = Object.keys(UPLOAD_TYPES);

/** Where a post's uploads go in the store: what a token for it allows, and nothing else. */
export function uploadPathPrefix(postId: number): string {
  return `posts/${postId}/`;
}

export function uploadKindOf(contentType: string): PostUploadKind | null {
  return UPLOAD_TYPES[contentType.split(';')[0]!.trim().toLowerCase()] ?? null;
}

/** The largest file of a kind: what Telegram takes for a photo, and the channel's video limit. */
export function uploadMaxBytes(kind: PostUploadKind, env: Pick<Env, 'MAX_VIDEO_SIZE_MB'>): number {
  return kind === 'photo' ? TELEGRAM_UPLOAD_PHOTO_MAX_BYTES : env.MAX_VIDEO_SIZE_MB * 1024 * 1024;
}

export function uploadsAvailable(env: Pick<Env, 'BLOB_STORE_ID' | 'BLOB_READ_WRITE_TOKEN'>): boolean {
  return Boolean(env.BLOB_STORE_ID || env.BLOB_READ_WRITE_TOKEN);
}

/** The store, behind what this app does with it — a test replaces it. */
export interface BlobStore {
  head(url: string): Promise<{ url: string; pathname: string; contentType: string; size: number }>;
  del(urls: string[]): Promise<void>;
}

/**
 * The project's store: reached as the project (OIDC, with `BLOB_STORE_ID`),
 * or with an older store's read-write token when one is set.
 */
export function vercelBlobStore(token?: string): BlobStore {
  const options = token ? { token } : undefined;
  return {
    head: (url) => head(url, options),
    del: (urls) => del(urls, options),
  };
}

export type UploadRow = typeof postUploads.$inferSelect;

/** An upload's ref in a rich document. */
export const uploadRef = (upload: Pick<UploadRow, 'id'>) => `u${upload.id}`;

/**
 * Record a file the browser says it uploaded for a post, once the store
 * confirms it: under the post's own path, of a type and size Telegram takes.
 * The same file twice is the same upload.
 */
export async function recordUpload(
  db: Database,
  store: BlobStore,
  input: { workspaceId: number; postId: number; url: string; env: Pick<Env, 'MAX_VIDEO_SIZE_MB'> },
): Promise<{ ok: true; upload: UploadRow } | { ok: false; error: string }> {
  let blob: Awaited<ReturnType<BlobStore['head']>>;
  try {
    blob = await store.head(input.url);
  } catch {
    return { ok: false, error: 'The file is not in the store.' };
  }
  if (!blob.pathname.startsWith(uploadPathPrefix(input.postId))) {
    return { ok: false, error: 'The file was not uploaded for this post.' };
  }
  const kind = uploadKindOf(blob.contentType);
  if (!kind) {
    await store.del([blob.url]).catch(() => {});
    return { ok: false, error: 'Only JPEG, PNG and WebP photos and MP4 videos can be uploaded.' };
  }
  const max = uploadMaxBytes(kind, input.env);
  if (blob.size > max) {
    await store.del([blob.url]).catch(() => {});
    return { ok: false, error: `The ${kind} is ${mb(blob.size)}; the limit is ${mb(max)}.` };
  }

  const [inserted] = await db
    .insert(postUploads)
    .values({
      workspaceId: input.workspaceId,
      processedPostId: input.postId,
      kind,
      url: blob.url,
      pathname: blob.pathname,
      contentType: blob.contentType,
      sizeBytes: blob.size,
    })
    .onConflictDoNothing({ target: postUploads.url })
    .returning();
  const upload =
    inserted ?? (await db.select().from(postUploads).where(eq(postUploads.url, blob.url)))[0];
  if (!upload || upload.processedPostId !== input.postId) return { ok: false, error: 'The file was not uploaded for this post.' };
  return { ok: true, upload };
}

/** A post's uploads still in the store, oldest first. */
export async function loadUploads(db: Database, postId: number): Promise<UploadRow[]> {
  return db
    .select()
    .from(postUploads)
    .where(and(eq(postUploads.processedPostId, postId), isNull(postUploads.deletedAt)))
    .orderBy(asc(postUploads.id));
}

/** An upload as publishing fetches it: media like any other, at its URL in the store. */
export function uploadAsMedia(upload: UploadRow): NormalizedMedia {
  return { mediaKey: uploadRef(upload), kind: upload.kind, url: upload.url, contentType: upload.contentType };
}

/**
 * Delete files from the store and mark them deleted. Best effort: a file that
 * cannot be deleted now is left marked as there, for the next sweep.
 */
export async function deleteUploads(
  db: Database,
  store: BlobStore,
  uploads: UploadRow[],
  logger?: Logger,
): Promise<number> {
  if (uploads.length === 0) return 0;
  try {
    await store.del(uploads.map((upload) => upload.url));
  } catch (error) {
    logger?.warn('uploads.delete_failed', { count: uploads.length, error: describeError(error) });
    return 0;
  }
  await db
    .update(postUploads)
    .set({ deletedAt: new Date() })
    .where(inArray(postUploads.id, uploads.map((upload) => upload.id)));
  return uploads.length;
}

/** Post states in which an upload may still be published: kept until the post leaves them. */
const STILL_OPEN = ['pending', 'processing', 'awaiting_approval', 'scheduled'] as const;

/**
 * The uploads of posts that will never be published now — published, turned
 * down, or failed for good — deleted from the store. Run after each sync.
 */
export async function sweepUploads(db: Database, store: BlobStore, logger: Logger): Promise<number> {
  const done = await db
    .select({ upload: postUploads })
    .from(postUploads)
    .innerJoin(processedPosts, eq(processedPosts.id, postUploads.processedPostId))
    .where(and(isNull(postUploads.deletedAt), notInArray(processedPosts.status, [...STILL_OPEN])))
    .limit(500);
  const deleted = await deleteUploads(
    db,
    store,
    done.map((row) => row.upload),
    logger,
  );
  if (deleted > 0) logger.info('uploads.swept', { deleted });
  return deleted;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
