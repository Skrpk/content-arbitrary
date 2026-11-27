import { after } from 'next/server';
import type { Env } from '@/lib/env';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import type { Database } from '@/lib/db';
import { track } from '@/lib/analytics/track';
import { addToWaitlist, capReached, onboardingAccess, onboardingOn, type WaitlistReason } from '@/lib/onboarding/access';
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
 * lookup, while ONBOARDING_ALLOWLIST is set at all.
 *
 *   /start       — someone with no channel yet: asked for one. A reviewer
 *                  gets the help they always have.
 *   /newchannel  — onboard another channel, up to ONBOARDING_WORKSPACES_PER_USER.
 *   plain text   — the channel, while one is awaited.
 *
 * Someone not on the allowlist, or past a global cap, is put on the
 * waitlist and told so (src/lib/onboarding/access.ts).
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

export async function handleOnboardingMessage(message: OnboardingMessage, context: OnboardingContext): Promise<boolean> {
  const from = message.from;
  if (message.chat.type !== 'private' || !from || !onboardingOn(context.env)) return false;

  const telegramUserId = String(from.id);
  const chatId = String(message.chat.id);
  const language = onboardingLanguage(from.language_code);
  const words = copy(language);
  const deps = { client: context.client, logger: context.logger.child({ fromId: from.id, surface: 'onboarding' }) };
  const parsed = parseCommand(message.text);
  const open = await findOpenSession(context.db, telegramUserId);
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || null;
  const waitlist = async (reason: WaitlistReason) => {
    await addToWaitlist(context.db, { telegramUserId, chatId, language, username: from.username ?? null, name, reason });
    await track(context.db, 'onboarding.waitlisted', { telegramUserId, props: { reason } }, deps.logger);
    deps.logger.info('onboarding.waitlisted', { reason });
    await say(deps, chatId, words.waitlisted);
  };

  if (parsed?.command === 'start' || parsed?.command === 'newchannel') {
    if (open) {
      await say(deps, chatId, open.status === 'awaiting_channel' ? words.stillWaiting : words.busy);
      return true;
    }
    if (parsed.command === 'start' && (await findWorkspacesByAdminChatId(context.db, from.id)).length > 0) return false;
    const access = await onboardingAccess(context.db, context.env, telegramUserId);
    if (!access.ok) {
      if (access.reason === 'off') return false;
      await waitlist(access.reason);
      return true;
    }
    const perUser = context.env.ONBOARDING_WORKSPACES_PER_USER;
    if ((await countSelfServiceWorkspaces(context.db, telegramUserId)) >= perUser) {
      await say(deps, chatId, words.tooMany(perUser));
      return true;
    }
    const session = await openSession(context.db, { telegramUserId, chatId, language });
    deps.logger.info('onboarding.started', { command: parsed.command });
    await track(context.db, 'onboarding.started', { telegramUserId, sessionId: session.id, props: { command: parsed.command, language } }, deps.logger);
    await say(deps, chatId, words.welcome);
    return true;
  }

  if (parsed || !open) return false;
  if (open.status !== 'awaiting_channel') {
    await say(deps, chatId, words.busy);
    return true;
  }

  await track(context.db, 'onboarding.channel_submitted', { telegramUserId, sessionId: open.id }, deps.logger);
  const channel = await validateChannel(message.text ?? '', {
    client: context.client,
    ...(context.fetchImpl ? { fetchImpl: context.fetchImpl } : {}),
  });
  if (!channel.ok) {
    deps.logger.info('onboarding.channel_refused', { reason: channel.reason });
    await track(context.db, 'onboarding.channel_validated', { telegramUserId, sessionId: open.id, props: { ok: false, reason: channel.reason } }, deps.logger);
    await say(deps, chatId, refusal(language, channel.reason));
    return true;
  }

  // Others may have onboarded since /start: the caps are checked again before anything is made.
  const cap = await capReached(context.db, context.env);
  if (cap) {
    await updateSession(context.db, open.id, { status: 'failed', errorCode: 'waitlisted', completedAt: new Date() });
    await waitlist(cap);
    return true;
  }

  const { user, workspace, created } = await provisionWorkspace(context.db, {
    telegramUserId,
    name,
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
  await track(
    context.db,
    'onboarding.channel_validated',
    { userId: user.id, telegramUserId, workspaceId: workspace.id, sessionId: open.id, props: { ok: true, created } },
    deps.logger,
  );

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
