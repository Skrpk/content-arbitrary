import { z } from 'zod';
import { track } from '@/lib/analytics/track';
import { describeError } from '@/lib/errors';
import { authorizeReviewer, json } from '@/lib/telegram/webapp-request';

/**
 * POST /api/telegram/webapp/events — the funnel events only a page sees
 * (prd-self-service-onboarding.md §29): the queue opened from a bot message,
 * the "set up the channel" popup shown, and its Open Settings pressed.
 *
 * Only those three names, each with its own few props, and only for a
 * channel the reviewer reviews: a page cannot write anything else into the
 * funnel. Always 204 once signed in, so a page never waits on it.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const bodySchema = z.discriminatedUnion('name', [
  z.object({
    name: z.literal('queue.opened'),
    workspaceId: z.number().int().positive().optional(),
    props: z.object({ from: z.enum(['digest', 'sources', 'command']) }).strict(),
  }),
  z.object({
    name: z.literal('publish.blocked'),
    workspaceId: z.number().int().positive().optional(),
    props: z.object({ action: z.enum(['publish', 'schedule']) }).strict(),
  }),
  z.object({
    name: z.literal('publish.popup_settings'),
    workspaceId: z.number().int().positive().optional(),
    props: z.object({}).strict().optional(),
  }),
]);

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

  // Someone else's channel is recorded as no channel, not refused: the page should not care.
  const workspaceId = auth.workspaces.some((workspace) => workspace.id === body.workspaceId) ? body.workspaceId : null;
  await track(auth.db, body.name, { userId: auth.user.id, workspaceId, props: body.props ?? {} }, auth.logger);
  return new Response(null, { status: 204 });
}
