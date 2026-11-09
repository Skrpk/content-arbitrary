import { z } from 'zod';
import { describeError } from '@/lib/errors';
import { authorizeReviewer, json } from '@/lib/telegram/webapp-request';
import { disconnectThreads, threadsAccountsFor, threadsAccountStatus } from '@/lib/threads/accounts';
import { threadsApp } from '@/lib/threads/config';

/**
 * The settings page's Threads accounts, one per channel the reviewer reviews
 * for: which are connected, as whom, and whether they still work.
 *
 * GET lists them. DELETE disconnects one. Connecting is on the website only
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

  const accounts = await threadsAccountsFor(
    auth.db,
    auth.workspaces.map((workspace) => workspace.id),
  );
  const now = new Date();
  return json({
    configured: threadsApp(auth.env) !== null,
    via: auth.via,
    websiteUrl: auth.env.WEB_APP_URL ?? null,
    accounts: accounts.map((account) => ({
      workspaceId: account.workspaceId,
      username: account.username,
      connectedAt: account.createdAt.toISOString(),
      status: threadsAccountStatus(account, now),
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
