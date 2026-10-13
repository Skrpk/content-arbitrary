import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { z } from 'zod';
import { describeError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { getEnv } from '@/lib/env';
import { findPostAwaitingReview } from '@/lib/sync/repository';
import { authorizeReviewer, json, reviewerWorkspaceForPost } from '@/lib/telegram/webapp-request';
import { UPLOAD_CONTENT_TYPES, uploadMaxBytes, uploadPathPrefix, uploadsAvailable } from '@/lib/uploads/uploads';

/**
 * Vercel Blob's client uploads, for the website editor (src/lib/uploads).
 *
 * The browser asks here for a token to upload one file for one post, and
 * sends the file straight to the store with it. A token is given only to the
 * post's reviewer, while the post waits, for a path under that post and the
 * types Telegram shows. The store calls back here when an upload completes;
 * that call is checked by its signature, and the file is recorded when the
 * browser registers it (./register), not here — a callback never reaches a
 * local server.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const clientPayloadSchema = z.object({ postId: z.number().int().positive() }).strict();

export async function POST(request: Request): Promise<Response> {
  const env = getEnv();
  if (!uploadsAvailable(env)) return json({ error: 'Uploads are not set up.' }, 503);

  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  if (body.type === 'blob.upload-completed') {
    try {
      // Checks the store's signature on the call itself.
      return json(
        await handleUpload({
          body,
          request,
          token: env.BLOB_READ_WRITE_TOKEN,
          onBeforeGenerateToken: async () => {
            throw new Error('not a token request');
          },
          onUploadCompleted: async ({ blob }) => {
            createLogger({ app: 'content-arbitrary', surface: 'uploads' }).info('uploads.completed', {
              pathname: blob.pathname,
            });
          },
        }),
      );
    } catch (error) {
      return json({ error: describeError(error) }, 400);
    }
  }

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

  try {
    const result = await handleUpload({
      body,
      request,
      token: env.BLOB_READ_WRITE_TOKEN,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith(uploadPathPrefix(postId))) throw new Error('not this post’s path');
        return {
          allowedContentTypes: UPLOAD_CONTENT_TYPES,
          // The larger of the two; the type's own limit is checked when the file is registered.
          maximumSizeInBytes: Math.max(uploadMaxBytes('photo', env), uploadMaxBytes('video', env)),
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ postId }),
        };
      },
      onUploadCompleted: async () => {},
    });
    auth.logger.info('uploads.token_issued', { postId, pathname: body.payload.pathname });
    return json(result);
  } catch (error) {
    auth.logger.warn('uploads.token_refused', { postId, error: describeError(error) });
    return json({ error: 'The upload was refused.' }, 400);
  }
}
