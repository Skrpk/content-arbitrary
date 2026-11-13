import { z } from 'zod';
import { payloadMediaCount, type ProcessedPost } from '@/db/schema';
import { assistantAvailable } from '@/lib/assistant/repository';
import { createRadarProvider } from '@/lib/radar/providers';
import { describeError } from '@/lib/errors';
import {
  initialRichDocument,
  parseRichDocument,
  RICH_MEDIA_MAX,
  RICH_TEXT_MAX,
} from '@/lib/rich/document';
import { sourceLabelOfPost } from '@/lib/sources/display';
import { findPostAwaitingReview, setRichDocument, setThreadsText } from '@/lib/sync/repository';
import { captionToPlainText, parsePostFooter, stripFooter } from '@/lib/telegram/post-footer';
import { authorizeReviewer, json, reviewerWorkspaceForPost } from '@/lib/telegram/webapp-request';
import { loadUploads, uploadMaxBytes, uploadPathPrefix, uploadRef, uploadsAvailable, type UploadRow } from '@/lib/uploads/uploads';
import { shownMediaUrl } from '@/lib/telegram-channel/media-link';
import { hasThreadsAccount } from '@/lib/threads/accounts';
import { threadsLength, THREADS_TEXT_LIMIT } from '@/lib/threads/text';

/**
 * The website editor's API: the post as a document to edit — the one saved,
 * or one made from its text and pictures — and saving it back, or dropping
 * it to publish the post as it was. For a channel with a Threads account,
 * also the post's own Threads text: saved, or cleared to follow Telegram's.
 *
 * Guarded like every reviewer endpoint, on a post of the reviewer's own
 * channel that has not gone out. What is saved is checked against what a
 * rich message may hold and against the post's own media
 * (src/lib/rich/document.ts) before it is stored.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const saveSchema = z
  .object({
    postId: z.number().int().positive(),
    /** The Telegram post; left out when only the Threads text changed. */
    doc: z.unknown().optional(),
    /** The post's own Threads text, or null to follow the Telegram text; left out to keep it. */
    threadsText: z.string().max(10_000).nullable().optional(),
  })
  .strict()
  .refine((body) => body.doc !== undefined || body.threadsText !== undefined, 'nothing to save');
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
  const uploads = await loadUploads(auth.db, post.id);

  return json({
    postId: post.id,
    status: post.status,
    channel: workspace.name,
    sourceLabel: sourceLabelOfPost(post.externalId, post.xAuthorUsername),
    url: post.xPostUrl,
    isRich: post.richDoc !== null,
    doc: post.richDoc ?? initialRichDocument({ text: plainTextOf(post, footer), mediaCount: payloadMediaCount(payload) }),
    media: [...mediaOf(post), ...uploads.map(uploadMedia)],
    footer: footer?.text ?? null,
    // The Threads tab, for a channel with an account there: the post's own text, or null while it follows Telegram's.
    // "Adapt for Threads" is the assistant's, on the model that rewrites posts (src/app/api/telegram/webapp/threads-adapt).
    threads: (await hasThreadsAccount(auth.db, workspace.id))
      ? { text: post.threadsText, adapt: assistantAvailable(auth.env) && createRadarProvider(auth.env) !== null }
      : null,
    limits: { text: RICH_TEXT_MAX - (footer ? footer.text.length + 2 : 0), media: RICH_MEDIA_MAX },
    // Whether the editor shows the AI assistant (src/app/api/telegram/webapp/assistant).
    assistant: assistantAvailable(auth.env),
    // Whether, where and how large photos and videos can be uploaded (src/lib/uploads).
    uploads: uploadsAvailable(auth.env)
      ? {
          pathPrefix: uploadPathPrefix(post.id),
          maxBytes: { photo: uploadMaxBytes('photo', auth.env), video: uploadMaxBytes('video', auth.env) },
        }
      : null,
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

  // Both checked before either is stored, so a save is all or nothing.
  let doc: Extract<ReturnType<typeof parseRichDocument>, { ok: true }>['doc'] | undefined;
  if (body.doc !== undefined) {
    const parsed = parseRichDocument(body.doc, {
      mediaCount: payloadMediaCount(found.post.approvalPayload!),
      uploads: new Set((await loadUploads(auth.db, body.postId)).map(uploadRef)),
      reservedChars: footer ? footer.text.length + 2 : 0,
    });
    if (!parsed.ok) return json({ error: parsed.error }, 422);
    doc = parsed.doc;
  }
  let threadsText: string | null | undefined;
  if (body.threadsText !== undefined) {
    if (!(await hasThreadsAccount(auth.db, found.workspace.id))) {
      return json({ error: 'This channel has no Threads account.' }, 422);
    }
    threadsText = body.threadsText === null ? null : body.threadsText.trim();
    if (threadsText === '') return json({ error: 'The Threads text is empty.' }, 422);
    if (threadsText !== null && threadsLength(threadsText) > THREADS_TEXT_LIMIT) {
      return json({ error: `Threads takes ${THREADS_TEXT_LIMIT} characters; this text is ${threadsLength(threadsText)}.` }, 422);
    }
  }

  const where = { id: body.postId, workspaceId: found.workspace.id };
  if (doc !== undefined && !(await setRichDocument(auth.db, { ...where, doc })).updated) {
    return json({ error: 'This post is no longer awaiting review.' }, 409);
  }
  if (threadsText !== undefined && !(await setThreadsText(auth.db, { ...where, text: threadsText })).updated) {
    return json({ error: 'This post is no longer awaiting review.' }, 409);
  }

  auth.logger.info('webapp.rich_saved', { postId: body.postId, doc: doc !== undefined, threads: threadsText !== undefined });
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
      previewUrl: shown ? shownMediaUrl(post.externalId, index, shown) : null,
    };
  });
}

/** An upload as the editor shows it: placed like the post's own, seen at its address in the store. */
function uploadMedia(upload: UploadRow) {
  return {
    ref: uploadRef(upload),
    kind: upload.kind,
    previewUrl: upload.kind === 'photo' ? upload.url : null,
    videoUrl: upload.kind === 'video' ? upload.url : null,
    uploaded: true,
  };
}
