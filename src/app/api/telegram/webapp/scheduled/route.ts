import { hasThreadsAccount } from '@/lib/threads/accounts';
import { z } from 'zod';
import { describeError } from '@/lib/errors';
import { loadRadarNote } from '@/lib/radar/review-note';
import { countScheduledPosts, loadScheduledPosts, SCHEDULED_PAGE_LIMIT } from '@/lib/review/scheduled';
import { sourceLabelOfPost } from '@/lib/sources/display';
import { buildApprovalKeyboard, formatReviewControlText, formatScheduleTime, isKnownTimeZone, reviewLinks } from '@/lib/sync/approval';
import { findDraft, scheduleDraft, unscheduleDraft } from '@/lib/drafts/drafts';
import { DRAFT_SCHEDULE_MAX_DAYS_AHEAD } from '@/lib/drafts/time';
import { unschedulePost } from '@/lib/sync/repository';
import { TelegramClient } from '@/lib/telegram/client';
import { TELEGRAM_PARSE_MODE } from '@/lib/telegram/format-caption';
import { authorizeReviewer, json, reviewerWorkspaceForPost } from '@/lib/telegram/webapp-request';
import { channelLabelFor } from '@/lib/workspace';
import { reviewCopiesOf } from '@/lib/review/copies';

/**
 * The Scheduled page's API: every post waiting for its time in the reviewer's
 * channels, soonest first — or with ?count=1 only how many — and taking one
 * back into the review queue.
 *
 * Moving its time is the Schedule endpoint's, and editing it the editor's —
 * both already take a scheduled post. Guarded like the other endpoints, and
 * settled by one guarded UPDATE, so it races the scheduler safely: a post
 * already on its way stays on its way.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('unschedule'), postId: z.number().int().positive() }).strict(),
  /** A post scheduled from the draft channel: back to waiting there, or another time. */
  z.object({ action: z.literal('unschedule_draft'), draftId: z.number().int().positive() }).strict(),
  z
    .object({
      action: z.literal('retime_draft'),
      draftId: z.number().int().positive(),
      scheduledFor: z.string().min(1),
      timezone: z.string().max(64).refine(isKnownTimeZone, 'unknown time zone').optional(),
    })
    .strict(),
]);

export async function GET(request: Request): Promise<Response> {
  let auth: Awaited<ReturnType<typeof authorizeReviewer>>;
  try {
    auth = await authorizeReviewer(request);
  } catch (error) {
    return json({ error: describeError(error) }, 500);
  }
  if (!auth.ok) return auth.response;

  // Only the number, for the website's header: no posts read for it.
  if (new URL(request.url).searchParams.get('count') === '1') {
    return json({ count: await countScheduledPosts(auth.db, auth.workspaces.map((workspace) => workspace.id)) });
  }

  const channels = await Promise.all(
    auth.workspaces.map(async (workspace) => ({
      id: workspace.id,
      name: workspace.name,
      items: await loadScheduledPosts(auth.db, workspace),
    })),
  );
  return json({ channels, limit: SCHEDULED_PAGE_LIMIT });
}

export async function POST(request: Request): Promise<Response> {
  let auth: Awaited<ReturnType<typeof authorizeReviewer>>;
  try {
    auth = await authorizeReviewer(request);
  } catch (error) {
    return json({ error: describeError(error) }, 500);
  }
  if (!auth.ok) return auth.response;

  let body: z.infer<typeof actionSchema>;
  try {
    body = actionSchema.parse(await request.json());
  } catch (error) {
    auth.logger.warn('webapp.bad_request', { error: describeError(error) });
    return json({ error: 'bad request' }, 400);
  }

  if (body.action !== 'unschedule') return draftAction(auth, body);

  const workspace = await reviewerWorkspaceForPost(auth, body.postId);
  if (!workspace) return json({ error: 'This post is no longer scheduled.' }, 409);

  const logger = auth.logger.child({ postId: body.postId, workspaceId: workspace.id });
  const result = await unschedulePost(auth.db, { id: body.postId, workspaceId: workspace.id });
  if (!result.unscheduled || !result.row) {
    logger.info('webapp.unschedule_not_applied', { currentStatus: result.currentStatus ?? 'unknown' });
    return json({ error: 'This post is no longer scheduled.' }, 409);
  }
  const row = result.row;
  logger.info('webapp.unscheduled', { externalId: row.externalId });

  // Its messages in the chats, if it has any, get their review buttons back — best effort.
  const controlText = formatReviewControlText(
    sourceLabelOfPost(row.externalId, row.xAuthorUsername),
    row.xPostUrl,
    channelLabelFor(workspace, auth.workspaces.length),
    await loadRadarNote(auth.db, row.id).catch(() => null),
  );
  const keyboard = buildApprovalKeyboard(row.id, {
    ...reviewLinks(auth.env.APP_BASE_URL, row.id),
    threads: await hasThreadsAccount(auth.db, workspace.id),
  });
  for (const copy of await reviewCopiesOf(auth.db, row)) {
    await new TelegramClient({ logger })
      .editMessageText(copy.chatId, copy.controlMessageId, controlText, TELEGRAM_PARSE_MODE, keyboard)
      .catch((error: unknown) => {
        logger.warn('webapp.unschedule_message_update_failed', { chatId: copy.chatId, error: describeError(error) });
      });
  }

  return json({ ok: true });
}

/**
 * A post scheduled from the draft channel, changed here: its control message
 * there says so too. Only a draft of the reviewer's own channels; another is
 * answered as one that is no longer scheduled.
 */
async function draftAction(
  auth: Extract<Awaited<ReturnType<typeof authorizeReviewer>>, { ok: true }>,
  body: Exclude<z.infer<typeof actionSchema>, { action: 'unschedule' }>,
): Promise<Response> {
  const draft = await findDraft(auth.db, body.draftId);
  if (!draft || draft.status !== 'scheduled' || !auth.workspaces.some((workspace) => workspace.id === draft.workspaceId)) {
    return json({ error: 'This post is no longer scheduled.' }, 409);
  }
  const logger = auth.logger.child({ draftId: draft.id, workspaceId: draft.workspaceId });
  const drafts = { db: auth.db, client: new TelegramClient({ logger }), logger };

  if (body.action === 'unschedule_draft') {
    const done = await unscheduleDraft(drafts, draft.id);
    if (!done) return json({ error: 'This post is no longer scheduled.' }, 409);
    logger.info('webapp.draft_unscheduled', {});
    return json({ ok: true });
  }

  const at = new Date(body.scheduledFor);
  if (Number.isNaN(at.getTime())) return json({ error: 'That is not a date and time.' }, 400);
  if (at.getTime() <= Date.now()) return json({ error: 'That time has already passed.' }, 400);
  if (at.getTime() - Date.now() > DRAFT_SCHEDULE_MAX_DAYS_AHEAD * 86_400_000) {
    return json({ error: 'That is more than a year ahead.' }, 400);
  }
  const timezone = body.timezone ?? draft.scheduledTimezone ?? 'UTC';
  const done = await scheduleDraft(drafts, { id: draft.id, at, timezone });
  if (!done?.scheduledFor) return json({ error: 'This post is no longer scheduled.' }, 409);
  logger.info('webapp.draft_retimed', { scheduledFor: at.toISOString() });
  return json({ scheduledFor: done.scheduledFor.toISOString(), display: formatScheduleTime(done.scheduledFor, done.scheduledTimezone) });
}
