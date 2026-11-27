import { track } from '@/lib/analytics/track';
import { z } from 'zod';
import { telegramIdOfUser } from '@/lib/accounts/users';
import { describeError } from '@/lib/errors';
import {
  CHANNEL_CHECK_MESSAGES,
  channelConnected,
  checkChannelConnection,
  markChannelConnected,
} from '@/lib/publishing/channel';
import { TelegramClient } from '@/lib/telegram/client';
import { authorizeReviewer, json } from '@/lib/telegram/webapp-request';

/**
 * Settings' Check button: connect the channel a workspace publishes to, so
 * Publish and Schedule work for it (src/lib/publishing/channel.ts).
 *
 * Connected only when the bot is an admin there that can post and the person
 * pressing is the channel's creator or an admin who can post — being a
 * reviewer of the workspace is not enough to publish to someone's channel.
 * A channel already connected is answered as connected, and nothing changes.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const bodySchema = z.object({ workspaceId: z.number().int().positive() }).strict();

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

  const workspace = auth.workspaces.find((candidate) => candidate.id === body.workspaceId);
  if (!workspace || !workspace.telegramChatId) return json({ error: 'No such channel.' }, 404);
  if (channelConnected(workspace)) return json({ connected: true });

  const userTelegramId = await telegramIdOfUser(auth.db, auth.user.id);
  if (!userTelegramId) return json({ error: 'Sign in with Telegram to connect a channel.', reason: 'user_not_admin' }, 422);

  const logger = auth.logger.child({ workspaceId: workspace.id });
  try {
    const check = await checkChannelConnection({
      client: new TelegramClient({ logger }),
      chatId: workspace.telegramChatId,
      userTelegramId,
    });
    if (!check.ok) {
      logger.info('webapp.channel_check_failed', { reason: check.reason });
      await track(auth.db, 'channel.check', { userId: auth.user.id, workspaceId: workspace.id, props: { result: check.reason } }, logger);
      return json({ error: CHANNEL_CHECK_MESSAGES[check.reason], reason: check.reason }, 422);
    }
  } catch (error) {
    logger.warn('webapp.channel_check_error', { error: describeError(error) });
    return json({ error: 'Telegram did not answer. Try again in a moment.' }, 502);
  }

  await markChannelConnected(auth.db, workspace.id);
  logger.info('webapp.channel_connected', { via: 'check' });
  await track(auth.db, 'channel.check', { userId: auth.user.id, workspaceId: workspace.id, props: { result: 'connected' } }, logger);
  await track(auth.db, 'channel.connected', { userId: auth.user.id, workspaceId: workspace.id, props: { via: 'check' } }, logger);
  return json({ connected: true });
}
