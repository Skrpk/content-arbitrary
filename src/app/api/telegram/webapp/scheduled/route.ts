import { z } from 'zod';
import { describeError } from '@/lib/errors';
import { loadRadarNote } from '@/lib/radar/review-note';
import { loadScheduledPosts, SCHEDULED_PAGE_LIMIT } from '@/lib/review/scheduled';
import { sourceLabelOfPost } from '@/lib/sources/display';
import { buildApprovalKeyboard, formatReviewControlText, reviewLinks } from '@/lib/sync/approval';
import { unschedulePost } from '@/lib/sync/repository';
import { TelegramClient } from '@/lib/telegram/client';
import { TELEGRAM_PARSE_MODE } from '@/lib/telegram/format-caption';
import { authorizeReviewer, json, reviewerWorkspaceForPost } from '@/lib/telegram/webapp-request';
import { channelLabelFor } from '@/lib/workspace';
import { reviewCopiesOf } from '@/lib/review/copies';

/**
 * The Scheduled page's API: every post waiting for its time in the reviewer's
 * channels, soonest first, and taking one back into the review queue.
 *
 * Moving its time is the Schedule endpoint's, and editing it the editor's —
 * both already take a scheduled post. Guarded like the other endpoints, and
 * settled by one guarded UPDATE, so it races the scheduler safely: a post
 * already on its way stays on its way.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const actionSchema = z.object({ action: z.literal('unschedule'), postId: z.number().int().positive() }).strict();

export async function GET(request: Request): Promise<Response> {
  let auth: Awaited<ReturnType<typeof authorizeReviewer>>;
  try {
    auth = await authorizeReviewer(request);
  } catch (error) {
    return json({ error: describeError(error) }, 500);
  }
  if (!auth.ok) return auth.response;

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
  const keyboard = buildApprovalKeyboard(row.id, reviewLinks(auth.env.APP_BASE_URL, row.id));
  for (const copy of await reviewCopiesOf(auth.db, row)) {
    await new TelegramClient({ logger })
      .editMessageText(copy.chatId, copy.controlMessageId, controlText, TELEGRAM_PARSE_MODE, keyboard)
      .catch((error: unknown) => {
        logger.warn('webapp.unschedule_message_update_failed', { chatId: copy.chatId, error: describeError(error) });
      });
  }

  return json({ ok: true });
}
