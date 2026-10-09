import { z } from 'zod';
import { describeError } from '@/lib/errors';
import { deleteSource, listSources, updateSourceSettings } from '@/lib/sources/repository';
import { authorizeReviewer, json } from '@/lib/telegram/webapp-request';
import { sourceView } from '@/lib/sources/view';

/**
 * The source Mini Apps' API: list the reviewer's sources, channel by
 * channel, change their per-source switches, and remove one.
 *
 * Guarded like the other Mini App endpoints — signed `initData` naming a
 * workspace's reviewer — and every read and write is scoped to the workspaces
 * they review for, so a source id from another tenant behaves as if it did
 * not exist.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const updateSchema = z
  .object({
    sourceId: z.number().int().positive(),
    enabled: z.boolean().optional(),
    includeTextOnly: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.enabled !== undefined || body.includeTextOnly !== undefined, {
    message: 'nothing to change',
  });

const deleteSchema = z.object({ sourceId: z.number().int().positive() }).strict();

export async function GET(request: Request): Promise<Response> {
  let auth: Awaited<ReturnType<typeof authorizeReviewer>>;
  try {
    auth = await authorizeReviewer(request);
  } catch (error) {
    return json({ error: describeError(error) }, 500);
  }
  if (!auth.ok) return auth.response;

  const channels = await Promise.all(
    auth.workspaces.map(async (workspace) => ({
      id: workspace.id,
      name: workspace.name,
      reviewDigestMinutes: workspace.reviewDigestMinutes,
      sources: (await listSources(auth.db, workspace.id)).map(sourceView),
    })),
  );
  return json({ channels });
}

export async function POST(request: Request): Promise<Response> {
  let auth: Awaited<ReturnType<typeof authorizeReviewer>>;
  try {
    auth = await authorizeReviewer(request);
  } catch (error) {
    return json({ error: describeError(error) }, 500);
  }
  if (!auth.ok) return auth.response;

  let body: z.infer<typeof updateSchema>;
  try {
    body = updateSchema.parse(await request.json());
  } catch (error) {
    auth.logger.warn('webapp.bad_request', { error: describeError(error) });
    return json({ error: 'bad request' }, 400);
  }

  const { sourceId, ...settings } = body;
  const updated = await updateSourceSettings(auth.db, {
    id: sourceId,
    workspaceIds: auth.workspaces.map((workspace) => workspace.id),
    settings,
  });

  if (!updated) return json({ error: 'No such source.' }, 404);

  auth.logger.info('webapp.source_settings_changed', { sourceId, ...settings });
  return json({ source: sourceView(updated) });
}

/** Remove a source for good. Its posts and its cursor stay behind. */
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
  } catch (error) {
    auth.logger.warn('webapp.bad_request', { error: describeError(error) });
    return json({ error: 'bad request' }, 400);
  }

  const removed = await deleteSource(auth.db, {
    id: body.sourceId,
    workspaceIds: auth.workspaces.map((workspace) => workspace.id),
  });
  if (!removed) return json({ error: 'No such source.' }, 404);

  auth.logger.info('webapp.source_removed', {
    sourceId: removed.id,
    workspaceId: removed.workspaceId,
    username: removed.username,
  });
  return json({ removed: removed.id });
}
