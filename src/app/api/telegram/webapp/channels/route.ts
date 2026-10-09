import { z } from 'zod';
import { describeError } from '@/lib/errors';
import { authorizeReviewer, json } from '@/lib/telegram/webapp-request';
import {
  REVIEW_DIGEST_MINUTES_MAX,
  REVIEW_DIGEST_MINUTES_MIN,
  setReviewDigestMinutes,
  usesReviewQueue,
} from '@/lib/workspace';

/**
 * The settings page's per-channel switches: for now, how often the reviewer
 * hears about the review queue — or that posts come to the chat one by one.
 *
 * Guarded like the other Mini App endpoints, and scoped to the channels the
 * reviewer reviews for: another tenant's id is answered as if it did not exist.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const updateSchema = z
  .object({
    workspaceId: z.number().int().positive(),
    /** Minutes between queue notifications, or null for each post in the chat. */
    reviewDigestMinutes: z.number().int().min(REVIEW_DIGEST_MINUTES_MIN).max(REVIEW_DIGEST_MINUTES_MAX).nullable(),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  let auth: Awaited<ReturnType<typeof authorizeReviewer>>;
  try {
    auth = await authorizeReviewer(request);
  } catch (error) {
    return json({ error: describeError(error) }, 500);
  }
  if (!auth.ok) return auth.response;

  let body: z.infer<typeof updateSchema>;
  try {
    body = updateSchema.parse(await request.json());
  } catch (error) {
    auth.logger.warn('webapp.bad_request', { error: describeError(error) });
    return json({ error: 'bad request' }, 400);
  }

  const updated = await setReviewDigestMinutes(auth.db, {
    workspaceId: body.workspaceId,
    reviewerWorkspaceIds: auth.workspaces.map((workspace) => workspace.id),
    minutes: body.reviewDigestMinutes,
  });
  if (!updated) return json({ error: 'No such channel.' }, 404);

  auth.logger.info('webapp.review_digest_changed', {
    workspaceId: updated.id,
    reviewDigestMinutes: updated.reviewDigestMinutes,
  });
  return json({
    id: updated.id,
    reviewDigestMinutes: updated.reviewDigestMinutes,
    // A queue needs the Mini App; without it posts still come to the chat.
    queueActive: usesReviewQueue(updated, auth.env),
  });
}
