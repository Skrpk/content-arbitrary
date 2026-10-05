import { z } from 'zod';
import { describeError } from '@/lib/errors';
import { TelegramClient } from '@/lib/telegram/client';
import { unescapeHtml } from '@/lib/telegram/format-caption';
import { authorizeReviewer, json, reviewerWorkspaceForPost } from '@/lib/telegram/webapp-request';
import {
  formatRejectionNotice,
  REJECTION_NOTE_MAX_LENGTH,
  settleReviewMessage,
} from '@/lib/sync/approval';
import { findPostAwaitingReview, rejectWithReason } from '@/lib/sync/repository';

/**
 * The "Other" Mini App's API: reject a post with the reviewer's own reason.
 *
 * Guarded exactly like the caption editor — signed `initData`, a known
 * reviewer, a post of their own tenant still awaiting review — and settled by
 * the same single guarded UPDATE as the reason buttons, so it races Approve,
 * a reason tap and a second submit safely: the first to land wins.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const rejectSchema = z.object({
  postId: z.number().int().positive(),
  /** Plain text as typed; optional — choosing "Other" is itself the reason. */
  note: z.string().optional(),
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

  const post = await findPostAwaitingReview(auth.db, { id: postId, workspaceId: workspace.id });
  if (!post || !post.approvalPayload) {
    return json({ error: 'This post is no longer awaiting review.' }, 404);
  }

  return json({
    postId: post.id,
    sourceUsername: post.xAuthorUsername,
    // Shown for context only, so the reviewer can see what they are turning down.
    caption: unescapeHtml(post.caption ?? post.approvalPayload.caption),
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

  let body: z.infer<typeof rejectSchema>;
  try {
    body = rejectSchema.parse(await request.json());
  } catch (error) {
    auth.logger.warn('webapp.bad_request', { error: describeError(error) });
    return json({ error: 'bad request' }, 400);
  }

  const workspace = await reviewerWorkspaceForPost(auth, body.postId);
  if (!workspace) return json({ error: 'This post is no longer awaiting review.' }, 409);

  const note = body.note?.trim() ?? '';
  if (note.length > REJECTION_NOTE_MAX_LENGTH) {
    return json(
      { error: `The reason is ${note.length} characters; the limit is ${REJECTION_NOTE_MAX_LENGTH}.` },
      422,
    );
  }

  const result = await rejectWithReason(auth.db, {
    id: body.postId,
    workspaceId: workspace.id,
    reason: 'other',
    note,
  });

  if (!result.rejected || !result.row) {
    auth.logger.info('webapp.reject_not_applied', {
      postId: body.postId,
      currentStatus: result.currentStatus ?? 'unknown',
    });
    return json({ error: 'This post is no longer awaiting review.' }, 409);
  }

  auth.logger.info('webapp.rejected', {
    postId: body.postId,
    reason: 'other',
    noteLength: note.length,
  });

  // The decision is recorded; replacing the buttons in the chat is best effort.
  await settleReviewMessage(
    new TelegramClient({ logger: auth.logger }),
    result.row.adminChatId,
    result.row.adminMessageId,
    formatRejectionNotice({ reason: 'other', note, xPostUrl: result.row.xPostUrl }),
  );

  return json({ ok: true });
}
