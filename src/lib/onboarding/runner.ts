import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { workspaces, type OnboardingSession, type OnboardingStatus } from '@/db/schema';
import type { Database } from '@/lib/db';
import type { Env } from '@/lib/env';
import { AppError, describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { embedPublicationHistory } from '@/lib/history/embeddings/embed';
import { createEmbeddingProvider, type EmbeddingProvider } from '@/lib/history/embeddings/provider';
import { storeParsedPublicationHistory } from '@/lib/history/import-history';
import { buildPublicationProfile } from '@/lib/history/profile/build';
import { loadProfileSource } from '@/lib/history/profile/repository';
import { writeInitialProfile } from '@/lib/onboarding/initial-profile';
import {
  HISTORY_MIN_USEFUL_POSTS,
  ONBOARDING_MAX_ATTEMPTS,
  ONBOARDING_STEP_LEASE_MS,
} from '@/lib/onboarding/limits';
import { copy, type OnboardingLanguage } from '@/lib/onboarding/messages';
import { claimStep, runnableSessionIds, updateSession } from '@/lib/onboarding/session';
import { crawlChannelHistory, TELEGRAM_PUBLIC_ADAPTER } from '@/lib/onboarding/telegram-history';
import { createRadarProvider } from '@/lib/radar/providers';
import type { RadarProvider } from '@/lib/radar/providers/types';
import { TelegramClient } from '@/lib/telegram/client';
import { buildSettingsUrl } from '@/lib/telegram/commands';
import { TELEGRAM_PARSE_MODE } from '@/lib/telegram/format-caption';

/**
 * Runs onboarding a step at a time (§8). Each step is claimed with a lease
 * (claimStep), so two runners — the webhook's `after()` and the cron — never
 * run the same one; it commits the next status when it is done, and a runner
 * that dies leaves the lease to expire and the step to be run again.
 *
 * A step that fails for a reason that may pass — t.me or the model not
 * answering, a rate limit — is tried again later, backing off, up to
 * ONBOARDING_MAX_ATTEMPTS times; one that cannot succeed fails the session
 * at once. Either way the person is told.
 *
 * Steps so far: the channel's history, then its profile. Finding and
 * connecting sources comes next; until then onboarding ends with the profile.
 */

export interface RunnerDeps {
  db: Database;
  env: Pick<Env, 'APP_BASE_URL'>;
  client: Pick<TelegramClient, 'call' | 'editMessageText'>;
  /** The model that profiles the channel; without it the profiling step cannot run. */
  provider: RadarProvider | null;
  embeddings: EmbeddingProvider | null;
  logger: Logger;
  /** t.me pages; injected by tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** A step that cannot succeed by trying again. */
export class OnboardingStopped extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OnboardingStopped';
  }
}

interface StepResult {
  next: OnboardingStatus;
  progress?: Record<string, unknown>;
}

type Step = (session: OnboardingSession, deps: RunnerDeps) => Promise<StepResult>;

const STEPS: Partial<Record<OnboardingStatus, Step>> = {
  analyzing_history: readHistory,
  profiling: profile,
};

export type StepOutcome = 'ran' | 'retrying' | 'failed' | 'not_runnable';

/** Run the session's current step, if it is runnable now and no one else is running it. */
export async function runOnboardingStep(sessionId: number, deps: RunnerDeps): Promise<StepOutcome> {
  const now = deps.now?.() ?? new Date();
  const session = await claimStep(deps.db, sessionId, now, ONBOARDING_STEP_LEASE_MS);
  if (!session) return 'not_runnable';
  const step = STEPS[session.status];
  const logger = deps.logger.child({ onboardingSessionId: session.id, step: session.status, attempt: session.attempts });
  if (!step) {
    await updateSession(deps.db, session.id, { lockedUntil: null });
    return 'not_runnable';
  }

  try {
    logger.info('onboarding.step_started', {});
    const result = await step(session, { ...deps, logger });
    const done = result.next === 'active';
    await updateSession(deps.db, session.id, {
      status: result.next,
      attempts: 0,
      lockedUntil: null,
      nextAttemptAt: null,
      errorCode: null,
      errorMessage: null,
      progress: { ...session.progress, ...result.progress },
      ...(done ? { completedAt: new Date() } : {}),
    });
    logger.info('onboarding.step_completed', { next: result.next });
    return 'ran';
  } catch (error) {
    const message = describeError(error);
    const permanent = error instanceof OnboardingStopped || (error instanceof AppError && !error.transient);
    const code = error instanceof OnboardingStopped || error instanceof AppError ? error.code : 'error';
    const language = session.language as OnboardingLanguage;

    if (permanent || session.attempts >= ONBOARDING_MAX_ATTEMPTS) {
      logger.error('onboarding.failed', { code, error: message });
      await updateSession(deps.db, session.id, {
        status: 'failed',
        lockedUntil: null,
        errorCode: code,
        errorMessage: message.slice(0, 1000),
        completedAt: new Date(),
      });
      await say(deps, session.chatId, copy(language).failed);
      return 'failed';
    }

    const retryAfterMs = error instanceof AppError && error.retryAfterMs ? error.retryAfterMs : 30_000 * 2 ** (session.attempts - 1);
    logger.warn('onboarding.step_retrying', { code, error: message, retryAfterMs });
    await updateSession(deps.db, session.id, {
      lockedUntil: null,
      nextAttemptAt: new Date(now.getTime() + Math.min(retryAfterMs, 10 * 60_000)),
      errorCode: code,
      errorMessage: message.slice(0, 1000),
    });
    // Said once, on the first retry: more would only be noise.
    if (session.attempts === 1 && code === 'channel_rate_limited') await say(deps, session.chatId, copy(language).retrying);
    return 'retrying';
  }
}

/**
 * Run steps — this session's, or every runnable one's — until none is left
 * or `budgetMs` is spent; a step is only started with time left for it.
 */
export async function runOnboarding(
  deps: RunnerDeps,
  options: { sessionId?: number; budgetMs: number; stepTimeMs?: number; limit?: number },
): Promise<{ ran: number; failed: number; retrying: number }> {
  const started = Date.now();
  const stepTimeMs = options.stepTimeMs ?? 180_000;
  const tally = { ran: 0, failed: 0, retrying: 0 };
  const timeLeft = () => options.budgetMs - (Date.now() - started) >= stepTimeMs;

  while (timeLeft()) {
    const ids = options.sessionId ? [options.sessionId] : await runnableSessionIds(deps.db, deps.now?.() ?? new Date(), options.limit ?? 5);
    if (ids.length === 0) break;
    let progressed = false;
    for (const id of ids) {
      if (!timeLeft()) break;
      const outcome = await runOnboardingStep(id, deps);
      if (outcome === 'not_runnable') continue;
      tally[outcome] += 1;
      progressed = outcome === 'ran' || progressed;
    }
    if (!progressed) break;
  }
  return tally;
}

/** §9–§10: the channel's latest posts, stored as its publication history. */
async function readHistory(session: OnboardingSession, deps: RunnerDeps): Promise<StepResult> {
  if (!session.workspaceId || !session.channelUsername || !session.channelChatId) {
    throw new OnboardingStopped('no_channel', 'the session has no channel to read');
  }
  const crawl = await crawlChannelHistory(session.channelUsername, {
    publicationKey: session.channelChatId,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  if (crawl.usable === 0) throw new OnboardingStopped('no_posts', 'the channel has no posts with text or media');

  await storeParsedPublicationHistory({
    db: deps.db,
    workspaceId: session.workspaceId,
    source: {
      adapter: TELEGRAM_PUBLIC_ADAPTER,
      originalFilename: `t.me/s/${session.channelUsername}`,
      fileSha256: crawl.sha256,
      metadata: { inspected: crawl.inspected, usable: crawl.usable, exhausted: crawl.exhausted, onboardingSessionId: session.id },
    },
    parsed: crawl.parsed,
    logger: deps.logger,
  });

  const words = copy(session.language as OnboardingLanguage);
  const title = session.channelTitle ?? `@${session.channelUsername}`;
  await showStatus(
    deps,
    session,
    words.readHistory(title, crawl.usable) + (crawl.usable < HISTORY_MIN_USEFUL_POSTS ? `\n\n${words.fewPosts}` : ''),
  );
  return { next: 'profiling', progress: { usable: crawl.usable, inspected: crawl.inspected } };
}

/** §13–§14: what the channel publishes, its editorial profile and language, and its posts embedded. */
async function profile(session: OnboardingSession, deps: RunnerDeps): Promise<StepResult> {
  if (!session.workspaceId) throw new OnboardingStopped('no_workspace', 'the session has no workspace');
  if (!deps.provider) throw new OnboardingStopped('no_model', 'no model is configured to profile the channel');

  const source = await loadProfileSource(deps.db, session.workspaceId);
  if (!source.some((item) => item.text?.trim())) throw new OnboardingStopped('no_text', 'the channel’s posts have no text to learn from');

  const built = await buildPublicationProfile({ db: deps.db, provider: deps.provider, workspaceId: session.workspaceId, logger: deps.logger });
  const [workspace] = await deps.db.select().from(workspaces).where(eq(workspaces.id, session.workspaceId));
  if (!workspace) throw new OnboardingStopped('no_workspace', 'the workspace is gone');
  const initial = await writeInitialProfile({ db: deps.db, provider: deps.provider, workspace, publication: built.profile });

  // Radar's retrieval reads these; without them it still scores, so a failure here is not onboarding's.
  if (deps.embeddings) {
    await embedPublicationHistory({ db: deps.db, embeddings: deps.embeddings, workspaceId: session.workspaceId, logger: deps.logger }).catch(
      (error: unknown) => deps.logger.warn('onboarding.embedding_failed', { error: describeError(error) }),
    );
  }

  // In the channel's language when the model gave them; the analysis's own are in English.
  const topics = initial.topics.length > 0 ? initial.topics : built.profile.coreTopics.slice(0, 4).map((topic) => topic.name);
  const words = copy(session.language as OnboardingLanguage);
  const usable = typeof session.progress.usable === 'number' ? session.progress.usable : built.facts.items;
  await showStatus(deps, session, words.profiled(session.channelTitle ?? workspace.name, usable, topics));
  await say(deps, session.chatId, words.profileReady, settingsButton(deps, words.settings));

  return {
    next: 'active',
    progress: {
      topics,
      publicationProfileId: built.profileId,
      editorialProfileWritten: initial.written.profile,
      languageWritten: initial.written.language ? initial.language : null,
    },
  };
}

function settingsButton(deps: RunnerDeps, text: string) {
  return deps.env.APP_BASE_URL ? { inline_keyboard: [[{ text, web_app: { url: buildSettingsUrl(deps.env.APP_BASE_URL) } }]] } : undefined;
}

/** The progress message, edited in place; sent anew when there is none or it cannot be edited. */
async function showStatus(deps: RunnerDeps, session: OnboardingSession, text: string): Promise<void> {
  if (session.statusMessageId) {
    try {
      await deps.client.editMessageText(session.chatId, session.statusMessageId, text, TELEGRAM_PARSE_MODE);
      return;
    } catch (error) {
      deps.logger.warn('onboarding.status_edit_failed', { error: describeError(error) });
    }
  }
  const messageId = await say(deps, session.chatId, text);
  if (messageId) await updateSession(deps.db, session.id, { statusMessageId: messageId });
}

/** A message to the person; a failure to send is logged, never fails a step. */
export async function say(
  deps: Pick<RunnerDeps, 'client' | 'logger'>,
  chatId: string,
  text: string,
  replyMarkup?: unknown,
): Promise<number | null> {
  try {
    const sent = await deps.client.call(
      'sendMessage',
      {
        chat_id: chatId,
        text,
        parse_mode: TELEGRAM_PARSE_MODE,
        link_preview_options: { is_disabled: true },
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      },
      z.object({ message_id: z.number() }),
    );
    return sent.message_id;
  } catch (error) {
    deps.logger.warn('onboarding.message_failed', { error: describeError(error) });
    return null;
  }
}

/** The runner's dependencies as the app has them: the bot, the configured model and embeddings. */
export function runnerDeps(
  db: Database,
  env: Env,
  logger: Logger,
): RunnerDeps {
  return {
    db,
    env,
    client: new TelegramClient({ logger }),
    provider: createRadarProvider(env),
    embeddings: createEmbeddingProvider(env),
    logger,
  };
}
