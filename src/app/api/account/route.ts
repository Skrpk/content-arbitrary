import { z } from 'zod';
import { REVIEW_LINK_TARGETS } from '@/db/schema';
import { setReviewLink } from '@/lib/accounts/users';
import { describeError } from '@/lib/errors';
import { authorizeReviewer, json } from '@/lib/telegram/webapp-request';

/**
 * The signed-in person's own preferences — for now, where the bot's "Open
 * review queue" buttons take them. From a Mini App or the website alike.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const updateSchema = z.object({ reviewLink: z.enum(REVIEW_LINK_TARGETS) }).strict();

export async function GET(request: Request): Promise<Response> {
  let auth: Awaited<ReturnType<typeof authorizeReviewer>>;
  try {
    auth = await authorizeReviewer(request);
  } catch (error) {
    return json({ error: describeError(error) }, 500);
  }
  if (!auth.ok) return auth.response;

  return json({
    displayName: auth.user.displayName,
    reviewLink: auth.user.reviewLink,
    // The choice means something only once there is a website to choose.
    websiteUrl: auth.env.WEB_APP_URL ?? null,
  });
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

  await setReviewLink(auth.db, auth.user.id, body.reviewLink);
  auth.logger.info('account.review_link_changed', { reviewLink: body.reviewLink });
  return json({ reviewLink: body.reviewLink });
}
