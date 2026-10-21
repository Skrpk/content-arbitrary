import { z } from 'zod';
import { describeError } from '@/lib/errors';
import { isKnownTimeZone } from '@/lib/sync/approval';
import { authorizeReviewer, json } from '@/lib/telegram/webapp-request';
import { EDITORIAL_PROFILE_MAX_LENGTH, editorialProfileLength } from '@/lib/radar/editorial-profile';
import {
  REVIEW_DIGEST_MINUTES_MAX,
  REVIEW_DIGEST_MINUTES_MIN,
  setAutoPublish,
  setEditorialProfile,
  setReviewDigestMinutes,
  usesReviewQueue,
} from '@/lib/workspace';

/**
 * The settings page's per-channel settings: how often the reviewer hears
 * about the review queue — or that posts come to the chat one by one —,
 * whether the channel publishes without review at all, and the editorial
 * profile Radar scores posts against. Each request changes one of the three.
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
    reviewDigestMinutes: z
      .number()
      .int()
      .min(REVIEW_DIGEST_MINUTES_MIN)
      .max(REVIEW_DIGEST_MINUTES_MAX)
      .nullable()
      .optional(),
    /** Publish every post straight to the channel, with no review. */
    autoPublish: z.boolean().optional(),
    /** The channel's policy in the editor's words, for Radar; null or blank turns Radar off. */
    editorialProfile: z
      .string()
      .refine((text) => editorialProfileLength(text.trim()) <= EDITORIAL_PROFILE_MAX_LENGTH, {
        message: `at most ${EDITORIAL_PROFILE_MAX_LENGTH} characters`,
      })
      .nullable()
      .optional(),
    /** For a day or more: the hour, 0–23, in `timezone`; null for whenever it is due; absent to keep it. */
    reviewDigestHour: z.number().int().min(0).max(23).nullable().optional(),
    /** The browser's IANA zone, which the hour is in. */
    timezone: z.string().max(64).refine(isKnownTimeZone, 'unknown time zone').optional(),
  })
  .strict()
  .refine((body) => body.reviewDigestHour === undefined || body.reviewDigestHour === null || body.timezone, {
    message: 'an hour needs its time zone',
  })
  .refine(
    (body) =>
      [body.reviewDigestMinutes, body.autoPublish, body.editorialProfile].filter((value) => value !== undefined)
        .length === 1,
    { message: 'change one of reviewDigestMinutes, autoPublish or editorialProfile' },
  )
  .refine((body) => body.reviewDigestHour === undefined || body.reviewDigestMinutes !== undefined, {
    message: 'an hour goes with reviewDigestMinutes',
  });

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

  const reviewerWorkspaceIds = auth.workspaces.map((workspace) => workspace.id);

  if (body.editorialProfile !== undefined) {
    const updated = await setEditorialProfile(auth.db, {
      workspaceId: body.workspaceId,
      reviewerWorkspaceIds,
      editorialProfile: body.editorialProfile,
    });
    if (!updated) return json({ error: 'No such channel.' }, 404);
    // The length only: the text is the editor's, and logs are not the place for it.
    auth.logger.info('webapp.editorial_profile_changed', {
      workspaceId: updated.id,
      length: updated.editorialProfile === null ? null : editorialProfileLength(updated.editorialProfile),
    });
    return json({ id: updated.id, editorialProfile: updated.editorialProfile });
  }

  if (body.autoPublish !== undefined) {
    const updated = await setAutoPublish(auth.db, {
      workspaceId: body.workspaceId,
      reviewerWorkspaceIds,
      autoPublish: body.autoPublish,
    });
    if (!updated) return json({ error: 'No such channel.' }, 404);
    auth.logger.info('webapp.auto_publish_changed', { workspaceId: updated.id, autoPublish: updated.autoPublish });
    return json({
      id: updated.id,
      autoPublish: updated.autoPublish,
      queueActive: usesReviewQueue(updated, auth.env),
    });
  }

  const updated = await setReviewDigestMinutes(auth.db, {
    workspaceId: body.workspaceId,
    reviewerWorkspaceIds,
    minutes: body.reviewDigestMinutes!,
    hour:
      body.reviewDigestHour === undefined
        ? undefined
        : body.reviewDigestHour === null
          ? null
          : { hour: body.reviewDigestHour, timeZone: body.timezone! },
  });
  if (!updated) return json({ error: 'No such channel.' }, 404);

  auth.logger.info('webapp.review_digest_changed', {
    workspaceId: updated.id,
    reviewDigestMinutes: updated.reviewDigestMinutes,
    reviewDigestHour: updated.reviewDigestHour,
  });
  return json({
    id: updated.id,
    reviewDigestMinutes: updated.reviewDigestMinutes,
    reviewDigestHour: updated.reviewDigestHour,
    reviewDigestTimezone: updated.reviewDigestTimezone,
    autoPublish: updated.autoPublish,
    // A queue needs the Mini App; without it posts still come to the chat.
    queueActive: usesReviewQueue(updated, auth.env),
  });
}
