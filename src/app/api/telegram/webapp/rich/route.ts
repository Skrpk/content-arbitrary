import { z } from 'zod';
import { payloadMediaCount, type ProcessedPost } from '@/db/schema';
import { describeError } from '@/lib/errors';
import {
  initialRichDocument,
  parseRichDocument,
  RICH_MEDIA_MAX,
  RICH_TEXT_MAX,
} from '@/lib/rich/document';
import { sourceLabelOfPost } from '@/lib/sources/display';
import { findPostAwaitingReview, setRichDocument } from '@/lib/sync/repository';
import { captionToPlainText, parsePostFooter, stripFooter } from '@/lib/telegram/post-footer';
import { authorizeReviewer, json, reviewerWorkspaceForPost } from '@/lib/telegram/webapp-request';

/**
 * The website editor's API: the post as a document to edit — the one saved,
 * or one made from its text and pictures — and saving it back, or dropping
 * it to publish the post as it was.
 *
 * Guarded like every reviewer endpoint, on a post of the reviewer's own
 * channel that has not gone out. What is saved is checked against what a
 * rich message may hold and against the post's own media
 * (src/lib/rich/document.ts) before it is stored.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const saveSchema = z.object({ postId: z.number().int().positive(), doc: z.unknown() }).strict();
const dropSchema = z.object({ postId: z.number().int().positive() }).strict();

export async function GET(request: Request): Promise<Response> {
  const auth = await authorize(request);
  if (!auth.ok) return auth.response;

  const postId = Number(new URL(request.url).searchParams.get('post'));
  if (!Number.isSafeInteger(postId) || postId <= 0) return json({ error: 'bad post id' }, 400);

  const found = await openPost(auth, postId);
  if (!found) return json({ error: 'This post is no longer awaiting review.' }, 404);
  const { post, workspace } = found;
  const payload = post.approvalPayload!;
  const footer = parsePostFooter(workspace.postFooter);

  return json({
    postId: post.id,
    status: post.status,
    channel: workspace.name,
    sourceLabel: sourceLabelOfPost(post.xPostId, post.xAuthorUsername),
    url: post.xPostUrl,
    isRich: post.richDoc !== null,
    doc: post.richDoc ?? initialRichDocument({ text: plainTextOf(post, footer), mediaCount: payloadMediaCount(payload) }),
    media: mediaOf(post),
    footer: footer?.text ?? null,
    limits: { text: RICH_TEXT_MAX - (footer ? footer.text.length + 2 : 0), media: RICH_MEDIA_MAX },
  });
}

export async function POST(request: Request): Promise<Response> {
  const auth = await authorize(request);
  if (!auth.ok) return auth.response;

  let body: z.infer<typeof saveSchema>;
  try {
    body = saveSchema.parse(await request.json());
  } catch (error) {
    auth.logger.warn('webapp.bad_request', { error: describeError(error) });
    return json({ error: 'bad request' }, 400);
  }

  const found = await openPost(auth, body.postId);
  if (!found) return json({ error: 'This post is no longer awaiting review.' }, 409);
  const footer = parsePostFooter(found.workspace.postFooter);

  const parsed = parseRichDocument(body.doc, {
    mediaCount: payloadMediaCount(found.post.approvalPayload!),
    reservedChars: footer ? footer.text.length + 2 : 0,
  });
  if (!parsed.ok) return json({ error: parsed.error }, 422);

  const result = await setRichDocument(auth.db, { id: body.postId, workspaceId: found.workspace.id, doc: parsed.doc });
  if (!result.updated) return json({ error: 'This post is no longer awaiting review.' }, 409);

  auth.logger.info('webapp.rich_saved', { postId: body.postId });
  return json({ ok: true });
}

/** Back to the plain post: its caption and media as they were, published the usual way. */
export async function DELETE(request: Request): Promise<Response> {
  const auth = await authorize(request);
  if (!auth.ok) return auth.response;

  let body: z.infer<typeof dropSchema>;
  try {
    body = dropSchema.parse(await request.json());
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  const found = await openPost(auth, body.postId);
  if (!found) return json({ error: 'This post is no longer awaiting review.' }, 409);
  const result = await setRichDocument(auth.db, { id: body.postId, workspaceId: found.workspace.id, doc: null });
  if (!result.updated) return json({ error: 'This post is no longer awaiting review.' }, 409);

  auth.logger.info('webapp.rich_dropped', { postId: body.postId });
  return json({ ok: true });
}

async function authorize(request: Request) {
  try {
    return await authorizeReviewer(request);
  } catch (error) {
    return { ok: false as const, response: json({ error: describeError(error) }, 500) };
  }
}

/** The reviewer's post, still open to change, and its workspace; null otherwise. */
async function openPost(auth: Extract<Awaited<ReturnType<typeof authorizeReviewer>>, { ok: true }>, postId: number) {
  const workspace = await reviewerWorkspaceForPost(auth, postId);
  if (!workspace) return null;
  const post = await findPostAwaitingReview(auth.db, { id: postId, workspaceId: workspace.id, includeScheduled: true });
  if (!post?.approvalPayload) return null;
  return { post, workspace };
}

/**
 * The post's text for a new document: the whole of it — a rich message holds
 * far more than a caption — without the channel's footer, which the editor
 * shows apart and publishing adds back.
 */
function plainTextOf(post: ProcessedPost, footer: ReturnType<typeof parsePostFooter>): string {
  const payload = post.approvalPayload!;
  const stored = post.captionEditedAt ? (post.caption ?? payload.caption) : (payload.overflowMessage ?? post.caption ?? payload.caption);
  return captionToPlainText(stripFooter(stored, footer) ?? stored);
}

/** The post's media as the editor shows them: `m0`, `m1`… with a picture of each. */
function mediaOf(post: ProcessedPost) {
  const payload = post.approvalPayload!;
  const kinds = payload.items.length > 0 ? payload.items.map((item) => item.kind) : (payload.sourceMedia ?? []).map((media) => media.kind);
  return kinds.map((kind, index) => {
    const shown = post.reviewMedia?.[index];
    return {
      ref: `m${index}`,
      kind,
      previewUrl: (shown?.kind === 'photo' ? shown.url : shown?.previewUrl) ?? null,
    };
  });
}
