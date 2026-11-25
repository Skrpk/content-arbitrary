import { z } from 'zod';
import { isPublishablePayload } from '@/db/schema';
import { messageLink } from '@/lib/drafts/drafts';
import { describeError } from '@/lib/errors';
import { previewPost } from '@/lib/sync/publish';
import { findPostAwaitingReview } from '@/lib/sync/repository';
import { TelegramClient } from '@/lib/telegram/client';
import { parsePostFooter } from '@/lib/telegram/post-footer';
import { authorizeReviewer, json, reviewerWorkspaceForPost } from '@/lib/telegram/webapp-request';
import { destinationFor } from '@/lib/workspace';

/**
 * Send to preview: the Approve dialog's button. The post goes to the
 * channel's preview channel exactly as it would go out to the channel now —
 * its edits, layout, media and footer — and nothing is decided: it stays in
 * the queue (or on the schedule), to be edited and previewed again, then
 * scheduled or published from Zmistik.
 *
 * Guarded like every reviewer endpoint, on a post of the reviewer's own
 * channel that has not gone out, for a channel with a preview channel set in
 * Settings. Each press sends a new copy; earlier ones are left as they are.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A queued post's media are fetched again, as on publishing — a video can take a while.
export const maxDuration = 300;

const bodySchema = z.object({ postId: z.number().int().positive() }).strict();

export async function POST(request: Request): Promise<Response> {
  let auth: Awaited<ReturnType<typeof authorizeReviewer>>;
  try {
    auth = await authorizeReviewer(request);
  } catch (error) {
    return json({ error: describeError(error) }, 500);
  }
  if (!auth.ok) return auth.response;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  const workspace = await reviewerWorkspaceForPost(auth, body.postId);
  const post = workspace
    ? await findPostAwaitingReview(auth.db, { id: body.postId, workspaceId: workspace.id, includeScheduled: true })
    : null;
  if (!workspace || !post) return json({ error: 'This post is no longer awaiting review.' }, 409);
  if (!workspace.previewChatId) return json({ error: 'This channel has no preview channel. Set one in Settings.' }, 422);
  if (!isPublishablePayload(post.approvalPayload)) return json({ error: 'Cannot preview: the post’s media are not on record.' }, 422);

  const resolved = destinationFor(workspace, auth.env);
  if (!resolved.ok) return json({ error: 'This channel is not configured.' }, 500);

  const logger = auth.logger.child({ postId: post.id, workspaceId: workspace.id });
  try {
    const result = await previewPost({
      db: auth.db,
      env: auth.env,
      client: new TelegramClient({ logger }),
      row: post,
      payload: post.approvalPayload,
      destination: resolved.destination,
      previewChatId: workspace.previewChatId,
      footer: parsePostFooter(workspace.postFooter),
      logger,
    });
    const first = result.messages[0]?.messageId ?? result.primaryMessageId;
    logger.info('webapp.previewed', { messages: result.messages.length });
    return json({ ok: true, link: first ? messageLink(workspace.previewChatId, first) : null });
  } catch (error) {
    const message = describeError(error);
    logger.warn('webapp.preview_failed', { error: message });
    return json({ error: `The preview could not be sent: ${message.slice(0, 300)}` }, 502);
  }
}
