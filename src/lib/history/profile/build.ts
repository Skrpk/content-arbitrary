import type { z } from 'zod';
import type { Database } from '@/lib/db';
import type { Logger } from '@/lib/logger';
import type { TokenUsage } from '@/lib/radar/output';
import type { RadarProvider } from '@/lib/radar/providers';
import {
  HISTORY_BATCH_CHARS,
  MERGE_INSTRUCTIONS,
  mergeInput,
  NOTES_INSTRUCTIONS,
  notesInput,
  packByBudget,
  PROFILE_INSTRUCTIONS,
  profileInput,
  PUBLICATION_PROFILE_PROMPT_VERSION,
  renderHistoryItem,
} from '@/lib/history/profile/prompt';
import {
  findProfile,
  insertPublicationProfile,
  latestPublicationProfile,
  loadProfileSource,
} from '@/lib/history/profile/repository';
import {
  historyNotesSchema,
  normaliseNotes,
  normaliseProfile,
  publicationProfileSchema,
  type HistoryNotes,
  type PublicationProfile,
} from '@/lib/history/profile/schema';
import { historyFacts, sourceFingerprint, type HistoryFacts } from '@/lib/history/profile/source';

/** One model call may take this long; a batch of notes is a long answer. */
const CALL_TIMEOUT_MS = 180_000;
/** Room for the model's reasoning as well as the notes or profile. */
const MAX_OUTPUT_TOKENS = 12_000;
/** Batches noted at once: a long history goes faster without a burst of requests. */
const CONCURRENCY = 4;

export interface ProfileBuildResult {
  /** `created`; `up_to_date` when this exact history was already profiled; `dry_run` when not stored. */
  status: 'created' | 'up_to_date' | 'dry_run';
  profileId: number | null;
  profile: PublicationProfile;
  facts: HistoryFacts;
  sourceFingerprint: string;
  historyCutoffAt: Date;
  model: string;
  promptVersion: string;
  /** Model calls made this run, and their tokens; zero when up to date. */
  calls: number;
  usage: TokenUsage;
  batches: number;
  /** The newest stored profile before this run, when it was made from other history. */
  stale: { profileId: number; sourceItemCount: number } | null;
}

/**
 * Distil the workspace's publication history into a profile.
 *
 * The history is never sent whole: posts are packed into batches of bounded
 * size, each batch is noted, notes are merged while they are too many for one
 * request, and the profile is written from what remains. History, prompt
 * version and model identify a profile; if one already exists for them,
 * nothing is spent unless `force` is set.
 */
export async function buildPublicationProfile(input: {
  db: Database;
  provider: RadarProvider;
  workspaceId: number;
  force?: boolean;
  dryRun?: boolean;
  logger?: Logger;
  /** Characters of posts per request; smaller in tests. */
  batchChars?: number;
}): Promise<ProfileBuildResult> {
  const { db, provider, workspaceId } = input;
  const budget = input.batchChars ?? HISTORY_BATCH_CHARS;

  const items = await loadProfileSource(db, workspaceId);
  const textItems = items.filter((item) => item.text?.trim());
  if (textItems.length === 0) {
    throw new Error(
      `Workspace ${workspaceId} has no publication history with text to profile. Import it first: npm run history:import`,
    );
  }

  const fingerprint = sourceFingerprint(items);
  const facts = historyFacts(items);
  const base = {
    facts,
    sourceFingerprint: fingerprint,
    historyCutoffAt: facts.lastPublishedAt,
    model: provider.model,
    promptVersion: PUBLICATION_PROFILE_PROMPT_VERSION,
  };

  const latest = await latestPublicationProfile(db, workspaceId);
  const stale =
    latest && latest.sourceFingerprint !== fingerprint
      ? { profileId: latest.id, sourceItemCount: latest.sourceItemCount }
      : null;

  if (!input.force) {
    const existing = await findProfile(db, {
      workspaceId,
      sourceFingerprint: fingerprint,
      promptVersion: PUBLICATION_PROFILE_PROMPT_VERSION,
      model: provider.model,
    });
    const parsed = existing ? publicationProfileSchema.safeParse(existing.profile) : null;
    if (existing && parsed?.success) {
      return {
        ...base,
        status: 'up_to_date',
        profileId: existing.id,
        profile: parsed.data,
        calls: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        batches: 0,
        stale: null,
      };
    }
  }

  const spent = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const ask = async <T>(instructions: string, request: string, schema: z.ZodType<T>, name: string): Promise<T> => {
    const { output, usage } = await provider.complete({
      instructions,
      input: request,
      schema,
      schemaName: name,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: CALL_TIMEOUT_MS,
    });
    spent.calls += 1;
    spent.inputTokens += usage.inputTokens;
    spent.outputTokens += usage.outputTokens;
    return output;
  };

  // Map: notes on each batch of posts.
  const rendered = textItems.map((item) => ({ id: item.id, text: renderHistoryItem(item) }));
  const batches = packByBudget(rendered, (piece) => piece.text.length, budget);
  let notes = await mapLimited(batches, CONCURRENCY, async (batch, index) => {
    input.logger?.info('history_profile.batch', { batch: index + 1, of: batches.length, posts: batch.length });
    const output = await ask(
      NOTES_INSTRUCTIONS,
      notesInput(batch.map((piece) => piece.text)),
      historyNotesSchema,
      'history_notes',
    );
    return normaliseNotes(output, new Set(batch.map((piece) => piece.id)));
  });

  // Reduce: merge notes while they are too many for one request.
  while (notes.length > 1 && notesSize(notes) > budget) {
    const groups = packByBudget(notes, (note) => JSON.stringify(note).length, budget);
    if (groups.every((group) => group.length === 1)) break;
    notes = await mapLimited(groups, CONCURRENCY, async (group) => {
      if (group.length === 1) return group[0]!;
      const candidates = new Set(group.flatMap((note) => note.representativeCandidates.map((c) => c.id)));
      const output = await ask(MERGE_INSTRUCTIONS, mergeInput(group), historyNotesSchema, 'history_notes');
      return normaliseNotes(output, candidates);
    });
  }

  // The profile, from the final notes and the measured facts.
  const output = await ask(
    PROFILE_INSTRUCTIONS,
    profileInput(facts, notes),
    publicationProfileSchema,
    'publication_profile',
  );
  const profile = normaliseProfile(output, new Set(items.map((item) => item.id)));
  const usage = { inputTokens: spent.inputTokens, outputTokens: spent.outputTokens };

  if (input.dryRun) {
    return { ...base, status: 'dry_run', profileId: null, profile, calls: spent.calls, usage, batches: batches.length, stale };
  }

  const row = await insertPublicationProfile(db, {
    workspaceId,
    profile,
    sourceItemCount: items.length,
    sourceFingerprint: fingerprint,
    historyCutoffAt: facts.lastPublishedAt,
    model: provider.model,
    promptVersion: PUBLICATION_PROFILE_PROMPT_VERSION,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    metadata: {
      textItems: facts.textItems,
      mediaOnlyItems: facts.mediaOnlyItems,
      firstPublishedAt: facts.firstPublishedAt.toISOString(),
      batches: batches.length,
      calls: spent.calls,
    },
  });
  input.logger?.info('history_profile.created', { workspaceId, profileId: row.id, calls: spent.calls });

  return { ...base, status: 'created', profileId: row.id, profile, calls: spent.calls, usage, batches: batches.length, stale };
}

function notesSize(notes: HistoryNotes[]): number {
  return notes.reduce((sum, note) => sum + JSON.stringify(note).length, 0);
}

/** Map with at most `limit` calls in flight, results in input order. */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
