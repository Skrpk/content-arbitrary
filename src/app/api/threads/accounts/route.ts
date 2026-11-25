import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { workspaces } from '@/db/schema';
import { describeError } from '@/lib/errors';
import { authorizeReviewer, json } from '@/lib/telegram/webapp-request';
import { disconnectThreads, threadsAccountsFor, threadsAccountStatus } from '@/lib/threads/accounts';
import { threadsApp } from '@/lib/threads/config';
import { normalizeTopicTag } from '@/lib/threads/text';

/**
 * The settings page's Threads accounts, one per channel the reviewer reviews
 * for: which are connected, as whom, and whether they still work.
 *
 * GET lists them, with each channel's Threads topic. DELETE disconnects one.
 * PATCH sets a channel's topic. Connecting is on the website only
 * (/api/threads/start), so a Mini App is told where that is.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: Request): Promise<Response> {
  let auth: Awaited<ReturnType<typeof authorizeReviewer>>;
  try {
    auth = await authorizeReviewer(request);
  } catch (error) {
    return json({ error: describeError(error) }, 500);
  }
  if (!auth.ok) return auth.response;

  // Only the channels with Threads on: for the rest, Settings has no Threads section.
  const enabled = auth.workspaces.filter((workspace) => workspace.threadsEnabled);
  const accounts = await threadsAccountsFor(
    auth.db,
    enabled.map((workspace) => workspace.id),
  );
  const now = new Date();
  return json({
    configured: threadsApp(auth.env) !== null,
    channels: enabled.map((workspace) => workspace.id),
    via: auth.via,
    websiteUrl: auth.env.WEB_APP_URL ?? null,
    accounts: accounts.map((account) => ({
      workspaceId: account.workspaceId,
      username: account.username,
      connectedAt: account.createdAt.toISOString(),
      status: threadsAccountStatus(account, now),
      topicTag: auth.workspaces.find((workspace) => workspace.id === account.workspaceId)?.threadsTopicTag ?? null,
    })),
  });
}

const deleteSchema = z.object({ workspaceId: z.number().int().positive() }).strict();

export async function DELETE(request: Request): Promise<Response> {
  let auth: Awaited<ReturnType<typeof authorizeReviewer>>;
  try {
    auth = await authorizeReviewer(request);
  } catch (error) {
    return json({ error: describeError(error) }, 500);
  }
  if (!auth.ok) return auth.response;

  let body: z.infer<typeof deleteSchema>;
  try {
    body = deleteSchema.parse(await request.json());
  } catch {
    return json({ error: 'bad request' }, 400);
  }
  if (!auth.workspaces.some((workspace) => workspace.id === body.workspaceId)) {
    return json({ error: 'No such channel.' }, 404);
  }
  const disconnected = await disconnectThreads(auth.db, body.workspaceId);
  auth.logger.info('threads.disconnected', { workspaceId: body.workspaceId, disconnected });
  return json({ ok: true });
}

const patchSchema = z.object({ workspaceId: z.number().int().positive(), topicTag: z.string().max(200) }).strict();

export async function PATCH(request: Request): Promise<Response> {
  let auth: Awaited<ReturnType<typeof authorizeReviewer>>;
  try {
    auth = await authorizeReviewer(request);
  } catch (error) {
    return json({ error: describeError(error) }, 500);
  }
  if (!auth.ok) return auth.response;

  let body: z.infer<typeof patchSchema>;
  try {
    body = patchSchema.parse(await request.json());
  } catch {
    return json({ error: 'bad request' }, 400);
  }
  if (!auth.workspaces.some((workspace) => workspace.id === body.workspaceId && workspace.threadsEnabled)) {
    return json({ error: 'No such channel.' }, 404);
  }
  const topic = normalizeTopicTag(body.topicTag);
  if (!topic.ok) return json({ error: topic.error }, 400);
  await auth.db
    .update(workspaces)
    .set({ threadsTopicTag: topic.tag, updatedAt: new Date() })
    .where(eq(workspaces.id, body.workspaceId));
  auth.logger.info('threads.topic_set', { workspaceId: body.workspaceId, topicTag: topic.tag });
  return json({ ok: true, topicTag: topic.tag });
}
