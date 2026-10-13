import { issueSignedToken } from '@vercel/blob';
import { handleUploadPresigned, type HandleUploadPresignedBody } from '@vercel/blob/client';
import { z } from 'zod';
import { describeError } from '@/lib/errors';
import { getEnv } from '@/lib/env';
import { findPostAwaitingReview } from '@/lib/sync/repository';
import { authorizeReviewer, json, reviewerWorkspaceForPost } from '@/lib/telegram/webapp-request';
import { UPLOAD_CONTENT_TYPES, uploadMaxBytes, uploadPathPrefix, uploadsAvailable } from '@/lib/uploads/uploads';

/**
 * Vercel Blob's presigned client uploads, for the website editor
 * (src/lib/uploads).
 *
 * The browser asks here for a presigned URL to upload one file for one post,
 * and sends the file straight to the store with it. One is given only to the
 * post's reviewer, while the post waits, for a path under that post and the
 * types Telegram shows, for ten minutes. The app reaches the store as the
 * project (OIDC) to sign it. The file is recorded when the browser registers
 * it (./register), which checks it in the store; no completion callback is
 * asked for — one never reaches a local server.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const clientPayloadSchema = z.object({ postId: z.number().int().positive() }).strict();
const VALID_FOR_MS = 10 * 60 * 1000;

export async function POST(request: Request): Promise<Response> {
  const env = getEnv();
  if (!uploadsAvailable(env)) return json({ error: 'Uploads are not set up.' }, 503);

  let body: HandleUploadPresignedBody;
  try {
    body = (await request.json()) as HandleUploadPresignedBody;
  } catch {
    return json({ error: 'bad request' }, 400);
  }
  if (body.type !== 'blob.generate-presigned-url') return json({ error: 'bad request' }, 400);

  let auth: Awaited<ReturnType<typeof authorizeReviewer>>;
  try {
    auth = await authorizeReviewer(request);
  } catch (error) {
    return json({ error: describeError(error) }, 500);
  }
  if (!auth.ok) return auth.response;

  const payload = clientPayloadSchema.safeParse(
    (() => {
      try {
        return JSON.parse(body.payload.clientPayload ?? 'null');
      } catch {
        return null;
      }
    })(),
  );
  if (!payload.success) return json({ error: 'bad request' }, 400);
  const { postId } = payload.data;

  const workspace = await reviewerWorkspaceForPost(auth, postId);
  const post = workspace
    ? await findPostAwaitingReview(auth.db, { id: postId, workspaceId: workspace.id, includeScheduled: true })
    : null;
  if (!post) return json({ error: 'This post is no longer awaiting review.' }, 409);

  // The larger of the two; the type's own limit is checked when the file is registered.
  const maximumSizeInBytes = Math.max(uploadMaxBytes('photo', env), uploadMaxBytes('video', env));
  try {
    const result = await handleUploadPresigned({
      body,
      request,
      webhookPublicKey: env.BLOB_WEBHOOK_PUBLIC_KEY ?? 'unused: no completion callback is asked for',
      getSignedToken: async (pathname) => {
        if (!pathname.startsWith(uploadPathPrefix(postId))) throw new Error('not this post’s path');
        const validUntil = Date.now() + VALID_FOR_MS;
        const constraints = { allowedContentTypes: UPLOAD_CONTENT_TYPES, maximumSizeInBytes, validUntil };
        return {
          token: await issueSignedToken({
            pathname,
            operations: ['put'],
            ...constraints,
            ...(env.BLOB_READ_WRITE_TOKEN ? { token: env.BLOB_READ_WRITE_TOKEN } : {}),
          }),
          urlOptions: { ...constraints, addRandomSuffix: true },
        };
      },
    });
    auth.logger.info('uploads.url_issued', { postId, pathname: body.payload.pathname });
    return json(result);
  } catch (error) {
    auth.logger.warn('uploads.url_refused', { postId, error: describeError(error) });
    return json({ error: 'The upload was refused.' }, 400);
  }
}
