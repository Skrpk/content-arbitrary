import { after } from 'next/server';
import type { Env } from '@/lib/env';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import type { Database } from '@/lib/db';
import { WORKSPACES_PER_USER } from '@/lib/onboarding/limits';
import { copy, onboardingLanguage, type OnboardingLanguage } from '@/lib/onboarding/messages';
import { runOnboardingStep, runnerDeps, say, type RunnerDeps } from '@/lib/onboarding/runner';
import { findOpenSession, openSession, updateSession } from '@/lib/onboarding/session';
import { validateChannel, type ChannelValidation } from '@/lib/onboarding/validate';
import { countSelfServiceWorkspaces, provisionWorkspace } from '@/lib/onboarding/workspace';
import type { TelegramClient } from '@/lib/telegram/client';
import { parseCommand } from '@/lib/telegram/commands';
import { findWorkspacesByAdminChatId } from '@/lib/workspace';

/**
 * The bot's private chat, for onboarding (§5a): checked before the reviewer
 * lookup, and only for someone ONBOARDING_ALLOWLIST lets in.
 *
 *   /start       — someone with no channel yet: asked for one. A reviewer
 *                  gets the help they always have.
 *   /newchannel  — onboard another channel, up to WORKSPACES_PER_USER.
 *   plain text   — the channel, while one is awaited.
 *
 * Returns whether it handled the message; anything else goes on to the
 * commands as before.
 */

export interface OnboardingMessage {
  chat: { id: number; type?: string };
  from?: { id: number; language_code?: string; first_name?: string; last_name?: string; username?: string };
  text?: string;
}

export interface OnboardingContext {
  db: Database;
  env: Env;
  client: TelegramClient;
  logger: Logger;
  /** Runs the first step once the webhook has answered; injected by tests. */
  kick?: (sessionId: number) => void;
  /** Channel checks' t.me reads; injected by tests. */
  fetchImpl?: typeof fetch;
}

export function onboardingAllowed(env: Pick<Env, 'ONBOARDING_ALLOWLIST'>, telegramUserId: number | undefined): boolean {
  return telegramUserId !== undefined && env.ONBOARDING_ALLOWLIST.includes(String(telegramUserId));
}

export async function handleOnboardingMessage(message: OnboardingMessage, context: OnboardingContext): Promise<boolean> {
  const from = message.from;
  if (message.chat.type !== 'private' || !from || !onboardingAllowed(context.env, from.id)) return false;

  const telegramUserId = String(from.id);
  const chatId = String(message.chat.id);
  const language = onboardingLanguage(from.language_code);
  const words = copy(language);
  const deps = { client: context.client, logger: context.logger.child({ fromId: from.id, surface: 'onboarding' }) };
  const parsed = parseCommand(message.text);
  const open = await findOpenSession(context.db, telegramUserId);

  if (parsed?.command === 'start' || parsed?.command === 'newchannel') {
    if (open) {
      await say(deps, chatId, open.status === 'awaiting_channel' ? words.stillWaiting : words.busy);
      return true;
    }
    if (parsed.command === 'start' && (await findWorkspacesByAdminChatId(context.db, from.id)).length > 0) return false;
    if ((await countSelfServiceWorkspaces(context.db, telegramUserId)) >= WORKSPACES_PER_USER) {
      await say(deps, chatId, words.tooMany(WORKSPACES_PER_USER));
      return true;
    }
    await openSession(context.db, { telegramUserId, chatId, language });
    deps.logger.info('onboarding.started', { command: parsed.command });
    await say(deps, chatId, words.welcome);
    return true;
  }

  if (parsed || !open) return false;
  if (open.status !== 'awaiting_channel') {
    await say(deps, chatId, words.busy);
    return true;
  }

  const channel = await validateChannel(message.text ?? '', {
    client: context.client,
    ...(context.fetchImpl ? { fetchImpl: context.fetchImpl } : {}),
  });
  if (!channel.ok) {
    deps.logger.info('onboarding.channel_refused', { reason: channel.reason });
    await say(deps, chatId, refusal(language, channel.reason));
    return true;
  }

  const { user, workspace, created } = await provisionWorkspace(context.db, {
    telegramUserId,
    name: [from.first_name, from.last_name].filter(Boolean).join(' ') || null,
    username: from.username ?? null,
    channel: { chatId: channel.chatId, title: channel.title },
    language,
  });
  const statusMessageId = await say(deps, chatId, created ? words.found(channel.title) : words.alreadyYours(channel.title));
  await updateSession(context.db, open.id, {
    userId: user.id,
    workspaceId: workspace.id,
    channelUsername: channel.username,
    channelChatId: channel.chatId,
    channelTitle: channel.title,
    status: 'analyzing_history',
    statusMessageId,
  });
  deps.logger.info('onboarding.channel_accepted', { workspaceId: workspace.id, created });

  (context.kick ?? kickSoon(context))(open.id);
  return true;
}

function refusal(language: OnboardingLanguage, reason: Exclude<ChannelValidation, { ok: true }>['reason']): string {
  const words = copy(language);
  if (reason === 'private') return words.privateChannel;
  if (reason === 'no_posts') return words.noPosts;
  if (reason === 'unavailable') return words.tryAgainLater;
  return words.notAChannel;
}

/**
 * The first step — reading the channel's history, a few seconds — once the
 * webhook has answered. Only that one: profiling takes longer than a webhook
 * may run, so the cron (src/app/api/cron/onboarding) takes it from there.
 */
function kickSoon(context: OnboardingContext): (sessionId: number) => void {
  return (sessionId) => {
    const deps: RunnerDeps = runnerDeps(context.db, context.env, context.logger.child({ surface: 'onboarding' }));
    try {
      after(async () => {
        await runOnboardingStep(sessionId, deps).catch((error: unknown) =>
          context.logger.warn('onboarding.kick_failed', { error: describeError(error) }),
        );
      });
    } catch {
      // Outside a request: the cron runs it within the minute.
    }
  };
}
