import { z } from 'zod';
import { describeError } from '@/lib/errors';
import { findPostAwaitingReview } from '@/lib/sync/repository';
import { authorizeReviewer, json, reviewerWorkspaceForPost } from '@/lib/telegram/webapp-request';
import { recordUpload, uploadRef, uploadsAvailable, vercelBlobStore } from '@/lib/uploads/uploads';

/**
 * The browser's word that a file it uploaded to the store is there: checked
 * in the store itself — the post's own path, a type and size Telegram takes —
 * and recorded, so the editor can place it as `u<id>`.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const registerSchema = z.object({ postId: z.number().int().positive(), url: z.string().url().max(2048) }).strict();

export async function POST(request: Request): Promise<Response> {
  let auth: Awaited<ReturnType<typeof authorizeReviewer>>;
  try {
    auth = await authorizeReviewer(request);
  } catch (error) {
    return json({ error: describeError(error) }, 500);
  }
  if (!auth.ok) return auth.response;
  if (!uploadsAvailable(auth.env)) return json({ error: 'Uploads are not set up.' }, 503);

  let body: z.infer<typeof registerSchema>;
  try {
    body = registerSchema.parse(await request.json());
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  const workspace = await reviewerWorkspaceForPost(auth, body.postId);
  const post = workspace
    ? await findPostAwaitingReview(auth.db, { id: body.postId, workspaceId: workspace.id, includeScheduled: true })
    : null;
  if (!workspace || !post) return json({ error: 'This post is no longer awaiting review.' }, 409);

  const result = await recordUpload(auth.db, vercelBlobStore(auth.env.BLOB_READ_WRITE_TOKEN!), {
    workspaceId: workspace.id,
    postId: body.postId,
    url: body.url,
    env: auth.env,
  });
  if (!result.ok) {
    auth.logger.warn('uploads.refused', { postId: body.postId, error: result.error });
    return json({ error: result.error }, 422);
  }

  auth.logger.info('uploads.recorded', {
    postId: body.postId,
    uploadId: result.upload.id,
    kind: result.upload.kind,
    sizeBytes: result.upload.sizeBytes,
  });
  return json({ ref: uploadRef(result.upload), kind: result.upload.kind, url: result.upload.url });
}
