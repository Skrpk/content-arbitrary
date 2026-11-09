import { z } from 'zod';
import { describeError } from '@/lib/errors';
import { addThreadsSource } from '@/lib/sources/add-threads';
import { sourceView } from '@/lib/sources/view';
import { authorizeReviewer, json } from '@/lib/telegram/webapp-request';
import { threadsReading } from '@/lib/threads/reader';

/**
 * Add a public Threads account from the Sources page: its @username or
 * threads.com link, and which of the reviewer's channels it is for. Guarded
 * like the other Mini App endpoints; the channel it goes to must be one the
 * reviewer reviews for.
 *
 *   POST /api/telegram/webapp/sources/threads  { account, workspaceId }
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const addSchema = z
  .object({
    account: z.string().trim().min(1).max(200),
    workspaceId: z.number().int().positive(),
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

  let body: z.infer<typeof addSchema>;
  try {
    body = addSchema.parse(await request.json());
  } catch (error) {
    auth.logger.warn('webapp.bad_request', { error: describeError(error) });
    return json({ error: 'bad request' }, 400);
  }

  if (!auth.workspaces.some((workspace) => workspace.id === body.workspaceId)) {
    return json({ error: 'That channel is not one of yours.' }, 404);
  }

  const result = await addThreadsSource(auth.db, {
    account: body.account,
    workspaceId: body.workspaceId,
    reading: threadsReading(auth.env),
    logger: auth.logger,
  });
  if (!result.ok) return json({ error: result.reason }, 422);

  return json({
    created: result.created,
    title: `@${result.username}`,
    workspaceId: body.workspaceId,
    source: sourceView(result.source),
  });
}
