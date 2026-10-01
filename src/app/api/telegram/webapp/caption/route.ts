import { z } from 'zod';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { describeError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { TelegramClient } from '@/lib/telegram/client';
import { TELEGRAM_PARSE_MODE, escapeHtml, unescapeHtml } from '@/lib/telegram/format-caption';
import { TELEGRAM_CAPTION_LIMIT } from '@/lib/telegram/limits';
import {
  initDataFromAuthorizationHeader,
  validateInitData,
} from '@/lib/telegram/webapp-auth';
import { findPostAwaitingReview, updateApprovalCaption } from '@/lib/sync/repository';
import { findWorkspaceByAdminChatId } from '@/lib/workspace';

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

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/**
 * Everything that must be true before a request may touch a post, resolved
 * once so GET and POST cannot drift apart on it.
 */
async function authorize(request: Request) {
  const logger = createLogger({ app: 'content-arbitrary', surface: 'webapp' });
  const env = getEnv();

  const initData = initDataFromAuthorizationHeader(request.headers.get('authorization'));
  const verdict = validateInitData(initData, env.TELEGRAM_BOT_TOKEN);

  if (!verdict.ok) {
    // The reason is logged but never returned: a caller learning *why* their
    // forgery failed is a step towards one that works.
    logger.warn('webapp.init_data_rejected', { reason: verdict.reason });
    return { ok: false as const, response: json({ error: 'unauthorized' }, 401) };
  }

  const db = getDb();
  const workspace = await findWorkspaceByAdminChatId(db, verdict.user.id);

  if (!workspace) {
    logger.warn('webapp.not_a_reviewer', { telegramUserId: verdict.user.id });
    return { ok: false as const, response: json({ error: 'unauthorized' }, 401) };
  }

  return {
    ok: true as const,
    db,
    env,
    workspace,
    logger: logger.child({ workspaceId: workspace.id, telegramUserId: verdict.user.id }),
  };
}

export async function GET(request: Request): Promise<Response> {
  let auth: Awaited<ReturnType<typeof authorize>>;
  try {
    auth = await authorize(request);
  } catch (error) {
    return json({ error: describeError(error) }, 500);
  }
  if (!auth.ok) return auth.response;

  const postId = Number(new URL(request.url).searchParams.get('post'));
  if (!Number.isSafeInteger(postId) || postId <= 0) {
    return json({ error: 'bad post id' }, 400);
  }

  const post = await findPostAwaitingReview(auth.db, { id: postId, workspaceId: auth.workspace.id });
  if (!post || !post.approvalPayload) {
    return json({ error: 'This post is no longer awaiting review.' }, 404);
  }

  return json({
    postId: post.id,
    sourceUsername: post.xAuthorUsername,
    xPostUrl: post.xPostUrl,
    mediaCount: post.approvalPayload.items.length,
    // The editor works in plain text; the stored caption is escaped.
    caption: unescapeHtml(post.approvalPayload.caption),
    limit: TELEGRAM_CAPTION_LIMIT,
    hasOverflowMessage: Boolean(post.approvalPayload.overflowMessage),
    edited: Boolean(post.approvalPayload.captionEditedAt),
  });
}

export async function POST(request: Request): Promise<Response> {
  let auth: Awaited<ReturnType<typeof authorize>>;
  try {
    auth = await authorize(request);
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

  const caption = body.caption.trim();

  /**
   * Length is checked on the plain text, which is what Telegram counts: the
   * caption is stored escaped, but HTML entities are resolved before the limit
   * applies, so `&amp;` costs one character and not five.
   */
  if (caption.length > TELEGRAM_CAPTION_LIMIT) {
    return json(
      { error: `Caption is ${caption.length} characters; the limit is ${TELEGRAM_CAPTION_LIMIT}.` },
      422,
    );
  }
  if (caption === '') {
    return json({ error: 'Caption cannot be empty.' }, 422);
  }

  const result = await updateApprovalCaption(auth.db, {
    id: body.postId,
    workspaceId: auth.workspace.id,
    caption: escapeHtml(caption),
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
    workspaceId: auth.workspace.id,
  });
  const previewMessageId = post?.approvalPayload?.adminMediaMessageId;
  let previewUpdated = false;

  if (post?.adminChatId && previewMessageId) {
    try {
      await new TelegramClient({ logger: auth.logger }).editMessageCaption(
        post.adminChatId,
        previewMessageId,
        escapeHtml(caption),
        TELEGRAM_PARSE_MODE,
      );
      previewUpdated = true;
    } catch (error) {
      auth.logger.warn('webapp.preview_update_failed', { error: describeError(error) });
    }
  }

  return json({ ok: true, caption, previewUpdated });
}
