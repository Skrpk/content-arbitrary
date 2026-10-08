import { z } from 'zod';
import { describeError } from '@/lib/errors';
import { addRssSource } from '@/lib/sources/add-rss';
import { authorizeReviewer, json } from '@/lib/telegram/webapp-request';
import { sourceView } from '@/lib/sources/view';

/**
 * Add an RSS / Atom feed from the Settings page: the URL, and which of the
 * reviewer's channels it is for. Guarded like the other Mini App endpoints;
 * the channel must be one the reviewer reviews for.
 *
 *   POST /api/telegram/webapp/sources/rss  { url, workspaceId }
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const addSchema = z
  .object({
    url: z.string().trim().min(1).max(2048),
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

  const result = await addRssSource(auth.db, {
    url: body.url,
    workspaceId: body.workspaceId,
    logger: auth.logger,
  });
  if (!result.ok) return json({ error: result.reason }, 422);

  return json({
    created: result.created,
    entries: result.entries,
    workspaceId: body.workspaceId,
    source: sourceView(result.source),
  });
}
