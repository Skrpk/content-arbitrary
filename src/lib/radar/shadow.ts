import type { Database } from '@/lib/db';
import type { RadarMode, RadarVariant } from '@/db/schema';
import { describeError } from '@/lib/errors';
import { scrub, type Logger } from '@/lib/logger';
import { RadarError } from '@/lib/radar/output';
import {
  LIVE_RADAR_PROMPT_VERSIONS,
  RADAR_EXAMPLES_PER_CLASS,
  usesApprovedRetrieval,
  usesHistoryRetrieval,
  type RadarImage,
  type RadarItem,
  type RadarPromptVersion,
} from '@/lib/radar/prompt';
import type { RadarProvider } from '@/lib/radar/providers';
import { findEvaluatedVariants, insertRadarEvaluation, loadRadarHistory } from '@/lib/radar/repository';
import { loadRadarPublicationProfile } from '@/lib/history/profile/repository';
import type { PublicationProfile } from '@/lib/history/profile/schema';
import type { EmbeddingProvider } from '@/lib/history/embeddings/provider';
import { retrieveSimilarPublications, toRetrievalRecord } from '@/lib/history/embeddings/retrieval';

/**
 * Shadow Radar: score a post and record the prediction, and nothing else.
 *
 * Nothing here may affect the post. Every failure is caught, logged and
 * recorded as a row, and the post goes to review exactly as it would have.
 */

const LIVE_CALL_TIMEOUT_MS = 20_000;
/** Radar's share of one sync run; past it, posts go to review unscored. */
const LIVE_RUN_BUDGET_MS = 120_000;
/** After this many failures in a row, Radar stops trying for the rest of the run. */
const LIVE_MAX_CONSECUTIVE_FAILURES = 3;
/** Finding similar past publications is one embedding call and one query; it gets this long at most. */
const RETRIEVAL_TIMEOUT_MS = 5_000;

/**
 * Radar's state for one sync run, shared by every tenant in it: the provider,
 * and the limits that stop a slow or failing API from eating the run's time.
 */
export interface RadarRun {
  provider: RadarProvider;
  /** For the retrieval prompt's similar past publications; without it that prompt runs without them. */
  embeddings: EmbeddingProvider | null;
  /** Every post is scored with each of these. */
  promptVersions: readonly RadarPromptVersion[];
  deadline: number;
  consecutiveFailures: number;
  now: () => number;
}

export function createRadarRun(options: {
  provider: RadarProvider;
  embeddings?: EmbeddingProvider | null;
  promptVersions?: readonly RadarPromptVersion[];
  now?: () => number;
  budgetMs?: number;
  /** Never past this (epoch ms) — the sync's own deadline. */
  notAfter?: number;
}): RadarRun {
  const now = options.now ?? Date.now;
  const ownDeadline = now() + (options.budgetMs ?? LIVE_RUN_BUDGET_MS);
  return {
    provider: options.provider,
    embeddings: options.embeddings ?? null,
    promptVersions: options.promptVersions ?? LIVE_RADAR_PROMPT_VERSIONS,
    deadline: options.notAfter === undefined ? ownDeadline : Math.min(ownDeadline, options.notAfter),
    consecutiveFailures: 0,
    now,
  };
}

export interface RadarSubject {
  workspaceId: number;
  processedPostId: number;
  profile: string;
  item: RadarItem;
  /** The post's first image, when it has one; without it only the text variant runs. */
  image?: RadarImage;
}

/**
 * Score a post as it is about to go to review. Never throws.
 */
export async function runLiveRadar(
  run: RadarRun,
  db: Database,
  subject: RadarSubject,
  logger: Logger,
): Promise<void> {
  try {
    const variants = variantsFor(subject.image);
    const remaining = run.deadline - run.now();

    if (remaining <= 0 || run.consecutiveFailures >= LIVE_MAX_CONSECUTIVE_FAILURES) {
      const reason =
        remaining <= 0 ? 'run budget exhausted' : 'stopped after repeated failures this run';
      logger.warn('radar.skipped', { processedPostId: subject.processedPostId, reason });
      await Promise.all(
        run.promptVersions.flatMap((version) =>
          variants.map((variant) =>
            insertRadarEvaluation(db, {
              ...setup(subject, run.provider, 'live', variant, version),
              status: 'skipped',
              imageIncluded: false,
              error: reason,
            }),
          ),
        ),
      );
      return;
    }

    const outcomes = await scoreAndRecord(db, run.provider, subject, {
      mode: 'live',
      // Only what was decided before this post arrived — which, live, is now.
      before: new Date(run.now()),
      timeoutMs: Math.min(LIVE_CALL_TIMEOUT_MS, remaining),
      embeddings: run.embeddings,
      promptVersions: run.promptVersions,
      logger,
    });

    if (outcomes.some((outcome) => outcome === 'failed')) run.consecutiveFailures += 1;
    else if (outcomes.some((outcome) => outcome === 'ok')) run.consecutiveFailures = 0;
  } catch (error) {
    // Even recording the failure failed; the post must still go to review.
    run.consecutiveFailures += 1;
    logger.error('radar.error', {
      processedPostId: subject.processedPostId,
      error: describeError(error),
    });
  }
}

/**
 * Score every prompt version and variant this post does not have yet under
 * the current setup, recording each as `ok` or `failed`.
 */
export async function scoreAndRecord(
  db: Database,
  provider: RadarProvider,
  subject: RadarSubject,
  options: {
    mode: RadarMode;
    before: Date;
    timeoutMs: number;
    logger: Logger;
    embeddings?: EmbeddingProvider | null;
    promptVersions?: readonly RadarPromptVersion[];
  },
): Promise<('ok' | 'failed' | 'exists')[]> {
  const pending: { version: RadarPromptVersion; variant: RadarVariant }[] = [];
  for (const version of options.promptVersions ?? LIVE_RADAR_PROMPT_VERSIONS) {
    const done = await findEvaluatedVariants(db, {
      processedPostId: subject.processedPostId,
      mode: options.mode,
      model: provider.model,
      promptVersion: version,
    });
    for (const variant of variantsFor(subject.image)) {
      if (!done.has(variant)) pending.push({ version, variant });
    }
  }
  if (pending.length === 0) return ['exists'];

  const history = await loadRadarHistory(db, {
    workspaceId: subject.workspaceId,
    before: options.before,
    excludePostId: subject.processedPostId,
    perClass: RADAR_EXAMPLES_PER_CLASS,
  });
  const examplePostIds = history.examples.map((example) => example.postId);
  const publication = await publicationContext(db, subject.workspaceId, options.before, options.logger);
  const publicationHistoryProfileId = publication?.id ?? null;

  // Searched once for every version that shows it; never stops the scoring.
  const retrieval = pending.some(({ version }) => usesHistoryRetrieval(version))
    ? await retrieveSimilarPublications({
        db,
        embeddings: options.embeddings ?? null,
        workspaceId: subject.workspaceId,
        processedPostId: subject.processedPostId,
        candidateText: subject.item.text,
        before: options.before,
        includeApproved: pending.some(({ version }) => usesApprovedRetrieval(version)),
        timeoutMs: Math.min(RETRIEVAL_TIMEOUT_MS, options.timeoutMs),
        logger: options.logger,
      })
    : null;

  return Promise.all(
    pending.map(async ({ version, variant }): Promise<'ok' | 'failed'> => {
      const image = variant === 'text_image' ? subject.image : undefined;
      const shown = usesHistoryRetrieval(version) ? retrieval : null;
      const withApproved = usesApprovedRetrieval(version);
      const historyRetrieval = shown ? toRetrievalRecord(shown, { approved: withApproved }) : null;
      const startedAt = Date.now();
      try {
        const prediction = await provider.score(
          {
            profile: subject.profile,
            approvalRate: history.approvalRate,
            item: subject.item,
            examples: history.examples,
            image,
            publicationProfile: publication?.profile ?? null,
            promptVersion: version,
            similarPublications: shown?.matches ?? null,
            similarApproved: withApproved ? (shown?.approved?.matches ?? []) : null,
          },
          { timeoutMs: options.timeoutMs },
        );

        await insertRadarEvaluation(db, {
          ...setup(subject, provider, options.mode, variant, version),
          status: 'ok',
          imageIncluded: Boolean(image),
          examplePostIds,
          publicationHistoryProfileId,
          historyRetrieval,
          historicalAssessment: shown ? prediction.historicalAssessment : null,
          score: prediction.score,
          predictedDecision: prediction.predictedDecision,
          topicFit: prediction.topicFit,
          editorialFit: prediction.editorialFit,
          importance: prediction.importance,
          reason: prediction.reason,
          predictedRejectionReason: prediction.predictedRejectionReason,
          inputTokens: prediction.inputTokens,
          outputTokens: prediction.outputTokens,
          latencyMs: Date.now() - startedAt,
        });

        options.logger.info('radar.scored', {
          processedPostId: subject.processedPostId,
          mode: options.mode,
          promptVersion: version,
          variant,
          latencyMs: Date.now() - startedAt,
        });
        return 'ok';
      } catch (error) {
        const usage = error instanceof RadarError ? error.usage : undefined;
        await insertRadarEvaluation(db, {
          ...setup(subject, provider, options.mode, variant, version),
          status: 'failed',
          imageIncluded: Boolean(image),
          examplePostIds,
          publicationHistoryProfileId,
          historyRetrieval,
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          latencyMs: Date.now() - startedAt,
          // Stored, unlike a log line, so it is scrubbed here explicitly.
          error: scrub(describeError(error)).slice(0, 500),
        });

        options.logger.warn('radar.failed', {
          processedPostId: subject.processedPostId,
          mode: options.mode,
          promptVersion: version,
          variant,
          error: describeError(error),
        });
        return 'failed';
      }
    }),
  );
}

/**
 * The publication-history profile for a post that arrived at `arrivedAt`, or
 * null. Optional context: failing to read it means scoring without it, never
 * not scoring — and never holding up the post.
 */
async function publicationContext(
  db: Database,
  workspaceId: number,
  arrivedAt: Date,
  logger: Logger,
): Promise<{ id: number; profile: PublicationProfile } | null> {
  try {
    return await loadRadarPublicationProfile(db, { workspaceId, arrivedAt, logger });
  } catch (error) {
    logger.warn('radar.history_profile_unavailable', { workspaceId, error: describeError(error) });
    return null;
  }
}

function variantsFor(image: RadarImage | undefined): RadarVariant[] {
  // With no image the text_image variant would be the text one again, at a cost.
  return image ? ['text', 'text_image'] : ['text'];
}

function setup(
  subject: RadarSubject,
  provider: RadarProvider,
  mode: RadarMode,
  variant: RadarVariant,
  promptVersion: RadarPromptVersion,
) {
  return {
    workspaceId: subject.workspaceId,
    processedPostId: subject.processedPostId,
    mode,
    variant,
    model: provider.model,
    promptVersion,
  };
}
