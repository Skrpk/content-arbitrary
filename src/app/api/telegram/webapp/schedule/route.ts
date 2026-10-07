import { loadRadarNote } from '@/lib/radar/review-note';
import { z } from 'zod';
import { describeError } from '@/lib/errors';
import { TelegramClient } from '@/lib/telegram/client';
import { TELEGRAM_PARSE_MODE } from '@/lib/telegram/format-caption';
import { captionToPlainText } from '@/lib/telegram/post-footer';
import { authorizeReviewer, json, reviewerWorkspaceForPost } from '@/lib/telegram/webapp-request';
import {
  buildScheduledKeyboard,
  formatScheduledNotice,
  formatScheduleTime,
  isKnownTimeZone,
  reviewLinks,
} from '@/lib/sync/approval';
import { findPostAwaitingReview, schedulePost } from '@/lib/sync/repository';
import { channelLabelFor } from '@/lib/workspace';

/**
 * The Schedule Mini App's API: approve a post for a later time, or move the
 * time of one already scheduled.
 *
 * Guarded like the other Mini App endpoints — signed `initData`, a known
 * reviewer, a post of their own tenant that has not gone out yet — and settled
 * by one guarded UPDATE, so it races Approve, Reject and the scheduler safely.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** How far ahead a post may be scheduled. */
const SCHEDULE_MAX_DAYS_AHEAD = 365;

const scheduleSchema = z.object({
  postId: z.number().int().positive(),
  /** The chosen moment as an ISO timestamp; the page converts from local time. */
  scheduledFor: z.string().min(1),
  /** The phone's IANA zone, used only to show the time back as it was picked. */
  timezone: z.string().max(64).optional(),
});

export async function GET(request: Request): Promise<Response> {
  let auth: Awaited<ReturnType<typeof authorizeReviewer>>;
  try {
    auth = await authorizeReviewer(request);
  } catch (error) {
    return json({ error: describeError(error) }, 500);
  }
  if (!auth.ok) return auth.response;

  const postId = Number(new URL(request.url).searchParams.get('post'));
  if (!Number.isSafeInteger(postId) || postId <= 0) {
    return json({ error: 'bad post id' }, 400);
  }

  const workspace = await reviewerWorkspaceForPost(auth, postId);
  if (!workspace) return json({ error: 'This post is no longer awaiting review.' }, 404);

  const post = await findPostAwaitingReview(auth.db, {
    id: postId,
    workspaceId: workspace.id,
    includeScheduled: true,
  });
  if (!post || !post.approvalPayload) {
    return json({ error: 'This post is no longer awaiting review.' }, 404);
  }

  return json({
    postId: post.id,
    sourceUsername: post.xAuthorUsername,
    caption: captionToPlainText(post.caption ?? post.approvalPayload.caption),
    scheduledFor: post.status === 'scheduled' ? post.scheduledFor?.toISOString() ?? null : null,
    timezone: post.scheduledTimezone,
    maxDaysAhead: SCHEDULE_MAX_DAYS_AHEAD,
  });
}

export async function POST(request: Request): Promise<Response> {
  let auth: Awaited<ReturnType<typeof authorizeReviewer>>;
  try {
    auth = await authorizeReviewer(request);
  } catch (error) {
    return json({ error: describeError(error) }, 500);
  }
  if (!auth.ok) return auth.response;

  let body: z.infer<typeof scheduleSchema>;
  try {
    body = scheduleSchema.parse(await request.json());
  } catch (error) {
    auth.logger.warn('webapp.bad_request', { error: describeError(error) });
    return json({ error: 'bad request' }, 400);
  }

  const workspace = await reviewerWorkspaceForPost(auth, body.postId);
  if (!workspace) return json({ error: 'This post is no longer awaiting review.' }, 409);

  const scheduledFor = new Date(body.scheduledFor);
  if (Number.isNaN(scheduledFor.getTime())) {
    return json({ error: 'bad request' }, 400);
  }

  const now = Date.now();
  if (scheduledFor.getTime() <= now) {
    return json({ error: 'That time has already passed. Pick a later one.' }, 422);
  }
  if (scheduledFor.getTime() > now + SCHEDULE_MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000) {
    return json({ error: `Pick a time within ${SCHEDULE_MAX_DAYS_AHEAD} days.` }, 422);
  }

  const timezone = body.timezone && isKnownTimeZone(body.timezone) ? body.timezone : 'UTC';

  const result = await schedulePost(auth.db, {
    id: body.postId,
    workspaceId: workspace.id,
    scheduledFor,
    timezone,
  });

  if (!result.scheduled || !result.row) {
    auth.logger.info('webapp.schedule_not_applied', {
      postId: body.postId,
      currentStatus: result.currentStatus ?? 'unknown',
    });
    return json({ error: 'This post is no longer awaiting review.' }, 409);
  }

  const row = result.row;
  auth.logger.info('webapp.scheduled', {
    postId: row.id,
    scheduledFor: scheduledFor.toISOString(),
    timezone,
  });

  // The decision is recorded; showing it in the chat is best effort.
  if (row.adminChatId && row.adminMessageId) {
    await new TelegramClient({ logger: auth.logger })
      .editMessageText(
        row.adminChatId,
        row.adminMessageId,
        formatScheduledNotice({
          scheduledFor,
          timezone,
          sourceUsername: row.xAuthorUsername,
          xPostUrl: row.xPostUrl,
          channel: channelLabelFor(workspace, auth.workspaces.length),
          radarNote: await loadRadarNote(auth.db, row.id).catch(() => null),
        }),
        TELEGRAM_PARSE_MODE,
        buildScheduledKeyboard(row.id, reviewLinks(auth.env.APP_BASE_URL, row.id)),
      )
      .catch((error: unknown) => {
        auth.logger.warn('webapp.schedule_message_update_failed', { error: describeError(error) });
      });
  }

  return json({
    ok: true,
    scheduledFor: scheduledFor.toISOString(),
    display: formatScheduleTime(scheduledFor, timezone),
  });
}
