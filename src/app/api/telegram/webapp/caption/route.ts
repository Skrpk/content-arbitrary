import { sourceLabelOfPost } from '@/lib/sources/display';
import { z } from 'zod';
import { describeError } from '@/lib/errors';
import { TelegramClient } from '@/lib/telegram/client';
import { TELEGRAM_PARSE_MODE, escapeHtml, unescapeHtml } from '@/lib/telegram/format-caption';
import {
  captionToPlainText,
  footerLength,
  parsePostFooter,
  stripFooter,
  withFooter,
} from '@/lib/telegram/post-footer';
import { TELEGRAM_CAPTION_LIMIT, TELEGRAM_MESSAGE_TEXT_LIMIT } from '@/lib/telegram/limits';
import { authorizeReviewer, json, reviewerWorkspaceForPost } from '@/lib/telegram/webapp-request';
import { findPostAwaitingReview, updateApprovalCaption } from '@/lib/sync/repository';
import { payloadMediaCount, type ApprovalPayload } from '@/db/schema';

/**
 * The Mini App's API: read the caption a post will be published with, and
 * replace it.
 *
 * This endpoint is openly reachable — a Mini App is just a web page, so being
 * open is the normal condition, not a lapse. What makes it safe is that nothing
 * is read or written until three things hold:
 *
 *   1. the request carries valid `initData`, signed by Telegram with a key
 *      derived from our bot token, and recent enough not to be a replay;
 *   2. the Telegram user it names is some workspace's reviewer;
 *   3. the post belongs to that workspace and is still awaiting review.
 *
 * The post id in the query string is therefore not a credential: supplying
 * someone else's gets the same answer as supplying one that does not exist.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const saveSchema = z.object({
  postId: z.number().int().positive(),
  /** Plain text as typed; escaping is this server's job, never the client's. */
  caption: z.string(),
});

/** A text-only post is a whole message; anything else, a caption under media. */
const lengthLimitFor = (payload: ApprovalPayload) =>
  payload.method === 'sendMessage' ? TELEGRAM_MESSAGE_TEXT_LIMIT : TELEGRAM_CAPTION_LIMIT;

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
    // A scheduled post has not gone out yet, so its text may still change.
    includeScheduled: true,
  });
  if (!post || !post.approvalPayload) {
    return json({ error: 'This post is no longer awaiting review.' }, 404);
  }

  // The editor works in plain text; the stored caption is escaped. The
  // fallback covers a post queued before the caption column existed.
  const stored = post.caption ?? post.approvalPayload.caption;
  // The footer is shown, not edited: the text box holds what is above it. A
  // post queued before the footer was set or changed has none to split off.
  const footer = parsePostFooter(workspace.postFooter);
  const body = stripFooter(stored, footer);

  return json({
    postId: post.id,
    sourceUsername: post.xAuthorUsername,
    sourceLabel: sourceLabelOfPost(post.xPostId, post.xAuthorUsername),
    xPostUrl: post.xPostUrl,
    mediaCount: payloadMediaCount(post.approvalPayload),
    caption: body === null ? captionToPlainText(stored) : unescapeHtml(body),
    footer: body === null ? null : footer!.text,
    limit: lengthLimitFor(post.approvalPayload) - (body === null ? 0 : footerLength(footer)),
    hasOverflowMessage: Boolean(post.approvalPayload.overflowMessage),
    edited: post.captionEditedAt !== null,
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

  let body: z.infer<typeof saveSchema>;
  try {
    body = saveSchema.parse(await request.json());
  } catch (error) {
    auth.logger.warn('webapp.bad_request', { error: describeError(error) });
    return json({ error: 'bad request' }, 400);
  }

  const workspace = await reviewerWorkspaceForPost(auth, body.postId);
  if (!workspace) return json({ error: 'This post is no longer awaiting review.' }, 409);

  const caption = body.caption.trim();

  const target = await findPostAwaitingReview(auth.db, {
    id: body.postId,
    workspaceId: workspace.id,
    includeScheduled: true,
  });
  if (!target?.approvalPayload) {
    return json({ error: 'This post is no longer awaiting review.' }, 409);
  }

  // The footer goes back under the text exactly as the editor showed it.
  const footer = parsePostFooter(workspace.postFooter);
  const stored = target.caption ?? target.approvalPayload.caption;
  const keepsFooter = stripFooter(stored, footer) !== null;

  /**
   * Length is checked on the plain text, which is what Telegram counts: the
   * caption is stored escaped, but HTML entities are resolved before the limit
   * applies, so `&amp;` costs one character and not five.
   */
  const limit = lengthLimitFor(target.approvalPayload) - (keepsFooter ? footerLength(footer) : 0);
  if (caption.length > limit) {
    return json(
      { error: `Caption is ${caption.length} characters; the limit is ${limit}.` },
      422,
    );
  }
  if (caption === '') {
    return json({ error: 'Caption cannot be empty.' }, 422);
  }

  const html = keepsFooter ? withFooter(escapeHtml(caption), footer) : escapeHtml(caption);
  const result = await updateApprovalCaption(auth.db, {
    id: body.postId,
    workspaceId: workspace.id,
    caption: html,
  });

  if (!result.updated) {
    auth.logger.info('webapp.caption_not_updated', {
      postId: body.postId,
      currentStatus: result.currentStatus ?? 'unknown',
    });
    return json({ error: 'This post is no longer awaiting review.' }, 409);
  }

  auth.logger.info('webapp.caption_updated', { postId: body.postId, length: caption.length });

  /**
   * Refresh the preview the reviewer is looking at, so Approve is pressed on
   * what they actually wrote. Best effort: the caption is already saved, and a
   * failed edit here must not make the save look like it did not happen.
   */
  const post = await findPostAwaitingReview(auth.db, {
    id: body.postId,
    workspaceId: workspace.id,
    includeScheduled: true,
  });
  const previewMessageId = post?.approvalPayload?.adminMediaMessageId;
  const client = new TelegramClient({ logger: auth.logger });
  let previewUpdated = false;

  if (post?.adminChatId && previewMessageId) {
    try {
      // A text-only post's preview is a text message, which has no caption.
      const edit =
        post.approvalPayload?.method === 'sendMessage'
          ? client.editMessageText.bind(client)
          : client.editMessageCaption.bind(client);
      await edit(post.adminChatId, previewMessageId, html, TELEGRAM_PARSE_MODE);
      previewUpdated = true;
    } catch (error) {
      auth.logger.warn('webapp.preview_update_failed', { error: describeError(error) });
    }
  }

  // The full-text follow-up will no longer be published; its preview must not
  // go on suggesting otherwise.
  if (post?.adminChatId && result.droppedOverflowPreviewId) {
    await client
      .editMessageText(
        post.adminChatId,
        result.droppedOverflowPreviewId,
        '✂️ This full text will not be published: your edited caption replaces it.',
        TELEGRAM_PARSE_MODE,
      )
      .catch((error: unknown) => {
        auth.logger.warn('webapp.overflow_preview_update_failed', { error: describeError(error) });
      });
  }

  return json({ ok: true, caption, previewUpdated });
}
