import { loadRadarNote } from '@/lib/radar/review-note';
import { sourceLabelOfPost } from '@/lib/sources/display';
import { isPublishablePayload } from '@/db/schema';
import type { Database } from '@/lib/db';
import type { Env } from '@/lib/env';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import type { TelegramClient } from '@/lib/telegram/client';
import { TELEGRAM_PARSE_MODE, escapeHtml } from '@/lib/telegram/format-caption';
import { TELEGRAM_MIN_DELAY_BETWEEN_SENDS_MS } from '@/lib/telegram/limits';
import {
  buildApprovalKeyboard,
  formatReviewControlText,
  formatScheduleTime,
  reviewLinks,
  settleReviewMessage,
} from '@/lib/sync/approval';
import { publishDecidedPost } from '@/lib/sync/publish';
import {
  abandonSchedule,
  claimScheduledForPublishing,
  listDueScheduledPostIds,
  returnToSchedule,
} from '@/lib/sync/repository';
import { defaultSleep } from '@/lib/sync/retry';
import {
  channelLabelFor,
  destinationFor,
  findWorkspaceById,
  findWorkspacesByAdminChatId,
} from '@/lib/workspace';

/**
 * Publish every scheduled post whose time has come.
 *
 * Run every minute. Each post is claimed with a conditional UPDATE before it
 * is sent, so overlapping runs, or a Publish now pressed in the same minute,
 * publish it once. A post that fails goes back on the schedule and is tried
 * again next minute; after MAX_RETRY_ATTEMPTS it returns to the review queue
 * and the reviewer is told, rather than the scheduler retrying forever.
 */

/** Posts per run. A minute later the rest are due again, so nothing is lost. */
export const SCHEDULED_POSTS_PER_RUN = 5;

export interface ScheduledRunSummary {
  due: number;
  published: number;
  failed: number;
  /** Claimed by someone else, retimed or cancelled between listing and claiming. */
  skipped: number;
  /** Given up on and sent back to review. */
  returnedToReview: number;
}

export async function publishDueScheduledPosts(input: {
  db: Database;
  env: Env;
  client: TelegramClient;
  logger: Logger;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
  /** Fetches a queued post's media; injected by tests. */
  fetchImpl?: typeof fetch;
}): Promise<ScheduledRunSummary> {
  const { db, env, client } = input;
  const now = input.now ?? new Date();
  const sleep = input.sleep ?? defaultSleep;

  const ids = await listDueScheduledPostIds(db, { now, limit: SCHEDULED_POSTS_PER_RUN });
  const summary: ScheduledRunSummary = {
    due: ids.length,
    published: 0,
    failed: 0,
    skipped: 0,
    returnedToReview: 0,
  };

  for (const [index, id] of ids.entries()) {
    const logger = input.logger.child({ postId: id });

    const row = await claimScheduledForPublishing(db, { id, now });
    if (!row) {
      summary.skipped += 1;
      continue;
    }

    // Space out sends so a burst of due posts does not trip flood control.
    if (index > 0) await sleep(TELEGRAM_MIN_DELAY_BETWEEN_SENDS_MS);

    /** Back on the schedule, or — once it has failed too often — back to review. */
    const fail = async (error: string) => {
      summary.failed += 1;
      const attempts = await returnToSchedule(db, { id, errorMessage: error, countAttempt: true });
      logger.error('scheduled.publish_failed', { xPostId: row.xPostId, attempts, error });

      if (attempts < env.MAX_RETRY_ATTEMPTS) return;

      await abandonSchedule(db, { id, errorMessage: error });
      summary.returnedToReview += 1;
      logger.error('scheduled.abandoned', { xPostId: row.xPostId, attempts });

      // Tell the reviewer, and give them the decision back.
      if (row.adminChatId && row.adminMessageId) {
        const reviewerWorkspaces = await findWorkspacesByAdminChatId(db, row.adminChatId);
        const channel = reviewerWorkspaces.find((candidate) => candidate.id === row.workspaceId);
        await client
          .editMessageText(
            row.adminChatId,
            row.adminMessageId,
            [
              `⚠️ Scheduled publishing failed ${attempts} times: ${escapeHtml(error.slice(0, 300))}`,
              'Back in review — approve or schedule it again.',
              formatReviewControlText(
                sourceLabelOfPost(row.xPostId, row.xAuthorUsername),
                row.xPostUrl,
                channel ? channelLabelFor(channel, reviewerWorkspaces.length) : null,
                await loadRadarNote(db, row.id).catch(() => null),
              ),
            ].join('\n'),
            TELEGRAM_PARSE_MODE,
            buildApprovalKeyboard(row.id, reviewLinks(env.APP_BASE_URL, row.id)),
          )
          .catch((notifyError: unknown) => {
            logger.warn('scheduled.notify_failed', { error: describeError(notifyError) });
          });
      }
    };

    const workspace = await findWorkspaceById(db, row.workspaceId);
    const resolved = workspace ? destinationFor(workspace, env) : null;
    if (!resolved?.ok) {
      await fail(resolved ? resolved.reason : 'workspace no longer exists');
      continue;
    }

    const payload = row.approvalPayload;
    if (!isPublishablePayload(payload)) {
      await fail('approval payload is missing');
      continue;
    }

    try {
      const result = await publishDecidedPost({
        db,
        env,
        client,
        fetchImpl: input.fetchImpl,
        row,
        payload,
        destination: resolved.destination,
        logger,
      });
      summary.published += 1;
      logger.info('scheduled.published', {
        xPostId: row.xPostId,
        scheduledFor: row.scheduledFor?.toISOString(),
        telegramMessageIds: result.messages.map((message) => message.messageId),
      });

      await settleReviewMessage(
        client,
        row.adminChatId,
        row.adminMessageId,
        [
          `✅ Published as scheduled, ${escapeHtml(formatScheduleTime(row.scheduledFor ?? now, row.scheduledTimezone))}`,
          escapeHtml(row.xPostUrl),
        ].join('\n'),
      );
    } catch (error) {
      await fail(describeError(error));
    }
  }

  return summary;
}
