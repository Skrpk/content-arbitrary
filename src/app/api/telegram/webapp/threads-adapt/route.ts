import { z } from 'zod';
import { assistantAvailable, countAssistantRequestsSince, insertAssistantRequest } from '@/lib/assistant/repository';
import { describeError } from '@/lib/errors';
import { createRadarProvider } from '@/lib/radar/providers';
import { costUsd } from '@/lib/radar/report';
import { findPostAwaitingReview } from '@/lib/sync/repository';
import { authorizeReviewer, json, reviewerWorkspaceForPost } from '@/lib/telegram/webapp-request';
import { hasThreadsAccount } from '@/lib/threads/accounts';
import { adaptForThreads, THREADS_ADAPT_PROMPT_VERSION } from '@/lib/threads/adapt';
import { loadTranslationStyle } from '@/lib/translation/translate';

/**
 * "Adapt for Threads": the post as the editor has it now, rewritten as a
 * Threads post, sent back for the Threads tab. Nothing is saved here.
 *
 * Guarded like every reviewer endpoint, on a post of the reviewer's own
 * channel that has not gone out and that has a Threads account. Each request
 * is recorded with what it cost and counts towards the assistant's
 * ASSISTANT_DAILY_LIMIT.
 *
 *   POST /api/telegram/webapp/threads-adapt  { postId, text } → { text }
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

const bodySchema = z
  .object({
    postId: z.number().int().positive(),
    /** The Telegram post as plain text, as unsaved as it is. */
    text: z.string().trim().min(1).max(40_000),
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

  const provider = assistantAvailable(env) ? createRadarProvider(env) : null;
  if (!provider) return json({ error: 'The assistant is not set up.' }, 503);

  const workspace = await reviewerWorkspaceForPost(auth, body.postId);
  const post = workspace
    ? await findPostAwaitingReview(db, { id: body.postId, workspaceId: workspace.id, includeScheduled: true })
    : null;
  if (!workspace || !post?.approvalPayload) return json({ error: 'This post is no longer awaiting review.' }, 404);
  if (!(await hasThreadsAccount(db, workspace.id))) return json({ error: 'This channel has no Threads account.' }, 422);

  const used = await countAssistantRequestsSince(db, { userId: auth.user.id, since: new Date(Date.now() - DAY_MS) });
  if (used >= env.ASSISTANT_DAILY_LIMIT) {
    return json({ error: `That is the ${env.ASSISTANT_DAILY_LIMIT} assistant requests for today. More tomorrow.` }, 429);
  }

  const startedAt = Date.now();
  const style = await loadTranslationStyle(db, workspace.id, logger);
  let result: Awaited<ReturnType<typeof adaptForThreads>> | null = null;
  let failure: string | null = null;
  try {
    result = await adaptForThreads(provider, { text: body.text, language: workspace.language, style });
    if (result.text === '') failure = 'empty answer';
  } catch (error) {
    failure = describeError(error);
  }
  const latencyMs = Date.now() - startedAt;
  const usage = { inputTokens: result?.inputTokens ?? 0, outputTokens: result?.outputTokens ?? 0 };

  logger.info('threads.adapted', {
    postId: post.id,
    ok: failure === null,
    latencyMs,
    // Not `inputTokens`: the logger redacts any key named *token*.
    usage: { input: usage.inputTokens, output: usage.outputTokens },
  });
  await insertAssistantRequest(db, {
    workspaceId: workspace.id,
    processedPostId: post.id,
    userId: auth.user.id,
    model: provider.model,
    promptVersion: THREADS_ADAPT_PROMPT_VERSION,
    status: failure ? 'failed' : 'ok',
    edited: false,
    webSearches: 0,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: costUsd(provider.model, usage),
    latencyMs,
    error: failure,
  }).catch((error: unknown) => logger.warn('assistant.record_failed', { error: describeError(error) }));

  if (failure || !result) return json({ error: 'Could not adapt it this time. Try again, or write it yourself.' }, 502);
  return json({ text: result.text });
}
