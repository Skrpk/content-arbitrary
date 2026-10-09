import { z } from 'zod';
import { isPublishablePayload, REJECTION_REASONS } from '@/db/schema';
import { describeError } from '@/lib/errors';
import { loadReviewQueue, REVIEW_QUEUE_PAGE_LIMIT } from '@/lib/review/queue';
import { TelegramClient } from '@/lib/telegram/client';
import { escapeHtml } from '@/lib/telegram/format-caption';
import { authorizeReviewer, json, reviewerWorkspaceForPost } from '@/lib/telegram/webapp-request';
import {
  formatRejectionNotice,
  REJECTION_NOTE_MAX_LENGTH,
  REJECTION_REASON_LABELS,
  settleReviewMessage,
} from '@/lib/sync/approval';
import { publishDecidedPost } from '@/lib/sync/publish';
import { claimForDecision, rejectWithReason, releaseToApproval } from '@/lib/sync/repository';
import { destinationFor } from '@/lib/workspace';

/**
 * The review queue page's API: every post awaiting review in the reviewer's
 * channels, best Radar score first, and the decision on one of them.
 *
 * Guarded like the other Mini App endpoints — signed `initData` naming a
 * workspace's reviewer, and a post of their own tenant — and decided by the
 * same single guarded UPDATEs as the chat's buttons, so a decision here races
 * one there, the scheduler or a second tap safely: the first to land wins.
 * A post that is also in the chat has its buttons there replaced by the
 * outcome, as if it had been decided there.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Approving a queued post fetches its media again — a video can take a while.
export const maxDuration = 300;

const decideSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), postId: z.number().int().positive() }).strict(),
  z
    .object({
      action: z.literal('reject'),
      postId: z.number().int().positive(),
      reason: z.enum(REJECTION_REASONS),
      /** Plain text as typed, with the `other` reason only. */
      note: z.string().optional(),
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

  const channels = await Promise.all(
    auth.workspaces.map(async (workspace) => {
      const queue = await loadReviewQueue(auth.db, workspace);
      return {
        id: workspace.id,
        name: workspace.name,
        waiting: queue.waiting,
        items: queue.items,
      };
    }),
  );

  return json({
    channels,
    limit: REVIEW_QUEUE_PAGE_LIMIT,
    reasons: REJECTION_REASONS.map((reason) => ({ value: reason, label: REJECTION_REASON_LABELS[reason] })),
    noteLimit: REJECTION_NOTE_MAX_LENGTH,
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

  let body: z.infer<typeof decideSchema>;
  try {
    body = decideSchema.parse(await request.json());
  } catch (error) {
    auth.logger.warn('webapp.bad_request', { error: describeError(error) });
    return json({ error: 'bad request' }, 400);
  }

  const workspace = await reviewerWorkspaceForPost(auth, body.postId);
  if (!workspace) return json({ error: 'This post is no longer awaiting review.' }, 409);

  const client = new TelegramClient({ logger: auth.logger });
  const logger = auth.logger.child({ postId: body.postId, workspaceId: workspace.id, action: body.action });

  if (body.action === 'reject') {
    const note = body.reason === 'other' ? (body.note?.trim() ?? '') : '';
    if (note.length > REJECTION_NOTE_MAX_LENGTH) {
      return json(
        { error: `The reason is ${note.length} characters; the limit is ${REJECTION_NOTE_MAX_LENGTH}.` },
        422,
      );
    }

    const result = await rejectWithReason(auth.db, {
      id: body.postId,
      workspaceId: workspace.id,
      reason: body.reason,
      note,
    });
    if (!result.rejected || !result.row) {
      logger.info('webapp.queue_not_applied', { currentStatus: result.currentStatus ?? 'unknown' });
      return json({ error: 'This post is no longer awaiting review.' }, 409);
    }

    logger.info('webapp.queue_rejected', { reason: body.reason, noteLength: note.length });
    await settleReviewMessage(
      client,
      result.row.adminChatId,
      result.row.adminMessageId,
      formatRejectionNotice({ reason: body.reason, note, xPostUrl: result.row.xPostUrl }),
    );
    return json({ ok: true });
  }

  const resolved = destinationFor(workspace, auth.env);
  if (!resolved.ok) {
    logger.error('webapp.queue_workspace_unpublishable', { reason: resolved.reason });
    return json({ error: 'This channel is not configured.' }, 500);
  }

  const claim = await claimForDecision(auth.db, body.postId, workspace.id, ['awaiting_approval']);
  if (!claim.claimed || !claim.row) {
    logger.info('webapp.queue_not_applied', { currentStatus: claim.currentStatus ?? 'unknown' });
    return json({ error: 'This post is no longer awaiting review.' }, 409);
  }
  const row = claim.row;

  if (!isPublishablePayload(row.approvalPayload)) {
    const reason = 'approval payload is missing; re-run the sync for this post';
    logger.error('webapp.queue_missing_payload', { xPostId: row.xPostId });
    await releaseToApproval(auth.db, { id: row.id, errorMessage: reason });
    return json({ error: 'Cannot publish: the post’s media are not on record.' }, 422);
  }

  try {
    const result = await publishDecidedPost({
      db: auth.db,
      env: auth.env,
      client,
      row,
      payload: row.approvalPayload,
      destination: resolved.destination,
      logger,
      reviewedAt: new Date(),
    });
    logger.info('webapp.queue_published', {
      xPostId: row.xPostId,
      telegramMessageIds: result.messages.map((message) => message.messageId),
    });
  } catch (error) {
    // Back in the queue, so it can simply be approved again.
    const message = describeError(error);
    logger.error('webapp.queue_publish_failed', { xPostId: row.xPostId, error: message });
    await releaseToApproval(auth.db, { id: row.id, errorMessage: message });
    return json({ error: `Publishing failed: ${message.slice(0, 300)}` }, 502);
  }

  await settleReviewMessage(client, row.adminChatId, row.adminMessageId, `✅ Published\n${escapeHtml(row.xPostUrl)}`);
  return json({ ok: true });
}
