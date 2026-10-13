import { z } from 'zod';
import { payloadMediaCount } from '@/db/schema';
import type { AssistantStreamEvent } from '@/lib/assistant/events';
import {
  ASSISTANT_PROMPT_VERSION,
  buildAssistantInstructions,
  buildPostContext,
  buildRetryMessage,
  buildTurnMessage,
  trimHistory,
} from '@/lib/assistant/prompt';
import {
  countAssistantRequestsSince,
  createAssistantModel,
  insertAssistantRequest,
} from '@/lib/assistant/repository';
import { describeError } from '@/lib/errors';
import { scrub } from '@/lib/logger';
import { costUsd } from '@/lib/radar/report';
import { parseRichDocument, RICH_TEXT_MAX } from '@/lib/rich/document';
import { editHtmlToRichDocument, richDocumentToEditHtml } from '@/lib/rich/edit-html';
import { sourceLabelOfPost } from '@/lib/sources/display';
import { findPostAwaitingReview } from '@/lib/sync/repository';
import { parsePostFooter } from '@/lib/telegram/post-footer';
import { authorizeReviewer, json, reviewerWorkspaceForPost } from '@/lib/telegram/webapp-request';
import { loadTranslationStyle } from '@/lib/translation/translate';

/**
 * The post editor's AI assistant: the editor's message and the post as it
 * reads in the editor now, answered as a stream of JSON lines — the reply as
 * it is written, web searches, the pages it cites, and the post rewritten
 * when asked.
 *
 * Guarded like every reviewer endpoint, on a post of the reviewer's own
 * channel that has not gone out. The assistant never saves anything: a
 * rewritten post is checked here exactly as a save would check it, then sent
 * to the editor, where the reviewer keeps it, undoes it, or saves it.
 * Every request is recorded with what it cost, and a reviewer gets
 * ASSISTANT_DAILY_LIMIT of them in 24 hours.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MODEL_TIMEOUT_MS = 50_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const bodySchema = z
  .object({
    postId: z.number().int().positive(),
    /** The editor's document, as unsaved as it is. */
    draft: z.unknown(),
    message: z.string().trim().min(1).max(2000),
    history: z
      .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(20_000) }).strict())
      .max(100)
      .default([]),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  let auth: Awaited<ReturnType<typeof authorizeReviewer>>;
  try {
    auth = await authorizeReviewer(request);
  } catch (error) {
    return json({ error: describeError(error) }, 500);
  }
  if (!auth.ok) return auth.response;
  const { db, env, logger } = auth;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (error) {
    logger.warn('webapp.bad_request', { error: describeError(error) });
    return json({ error: 'bad request' }, 400);
  }

  const model = createAssistantModel(env);
  if (!model) return json({ error: 'The assistant is not set up.' }, 503);

  const workspace = await reviewerWorkspaceForPost(auth, body.postId);
  const post = workspace
    ? await findPostAwaitingReview(db, { id: body.postId, workspaceId: workspace.id, includeScheduled: true })
    : null;
  if (!workspace || !post?.approvalPayload) return json({ error: 'This post is no longer awaiting review.' }, 404);

  const used = await countAssistantRequestsSince(db, { userId: auth.user.id, since: new Date(Date.now() - DAY_MS) });
  if (used >= env.ASSISTANT_DAILY_LIMIT) {
    return json({ error: `That is the ${env.ASSISTANT_DAILY_LIMIT} assistant requests for today. More tomorrow.` }, 429);
  }

  const payload = post.approvalPayload;
  const mediaCount = payloadMediaCount(payload);
  const footer = parsePostFooter(workspace.postFooter);
  const reservedChars = footer ? footer.text.length + 2 : 0;
  const draft = parseRichDocument(body.draft, { mediaCount, reservedChars });
  if (!draft.ok) return json({ error: draft.error }, 422);

  const kinds = payload.items.length > 0 ? payload.items.map((item) => item.kind) : (payload.sourceMedia ?? []).map((media) => media.kind);
  const style = await loadTranslationStyle(db, workspace.id, logger);
  const instructions = buildAssistantInstructions({
    channel: workspace.name,
    language: workspace.language,
    editorialProfile: workspace.editorialProfile,
    style,
  });
  const context = buildPostContext({
    sourceLabel: sourceLabelOfPost(post.externalId, post.xAuthorUsername),
    url: post.xPostUrl,
    sourceText: post.sourceText,
    media: kinds,
    textLimit: RICH_TEXT_MAX - reservedChars,
  });
  const message = buildTurnMessage(richDocumentToEditHtml(draft.doc), body.message);
  const history = trimHistory(body.history);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: AssistantStreamEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      const startedAt = Date.now();
      const totals = { inputTokens: 0, outputTokens: 0, webSearches: 0 };
      let edited = false;
      let failure: string | null = null;

      try {
        // One more try when the edit cannot be used, told why.
        let followUp: string | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const result = await model.runTurn({ instructions, context, history, message, followUp }, send, {
            timeoutMs: MODEL_TIMEOUT_MS,
            signal: request.signal,
          });
          totals.inputTokens += result.usage.inputTokens;
          totals.outputTokens += result.usage.outputTokens;
          totals.webSearches += result.webSearches;

          let problem = result.editError;
          if (result.edit && !problem) {
            const checked = parseRichDocument(editHtmlToRichDocument(result.edit.html), { mediaCount, reservedChars });
            if (checked.ok) {
              edited = true;
              send({ type: 'edit', doc: checked.doc, summary: result.edit.summary.trim() });
            } else {
              problem = checked.error;
            }
          }
          if (!problem) break;
          if (attempt === 0) {
            followUp = buildRetryMessage(problem);
            continue;
          }
          send({ type: 'error', message: `The assistant's edit could not be used: ${problem}` });
        }
        send({ type: 'done', remaining: Math.max(0, env.ASSISTANT_DAILY_LIMIT - used - 1) });
      } catch (error) {
        failure = scrub(describeError(error)).slice(0, 500);
        logger.warn('assistant.failed', { postId: post.id, error: failure });
        send({ type: 'error', message: 'The assistant could not answer. Try again in a moment.' });
      } finally {
        const latencyMs = Date.now() - startedAt;
        logger.info('assistant.answered', {
          postId: post.id,
          model: model.model,
          edited,
          webSearches: totals.webSearches,
          latencyMs,
          // Not `inputTokens`: the logger redacts any key named *token*.
          usage: { input: totals.inputTokens, output: totals.outputTokens },
        });
        await insertAssistantRequest(db, {
          workspaceId: workspace.id,
          processedPostId: post.id,
          userId: auth.user.id,
          model: model.model,
          promptVersion: ASSISTANT_PROMPT_VERSION,
          status: failure ? 'failed' : 'ok',
          edited,
          webSearches: totals.webSearches,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          costUsd: costUsd(model.model, totals),
          latencyMs,
          error: failure,
        }).catch((error: unknown) => logger.warn('assistant.record_failed', { error: describeError(error) }));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  });
}
