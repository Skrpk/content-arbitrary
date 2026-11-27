import { and, asc, eq, inArray } from 'drizzle-orm';
import { sourceSuggestions, type SourceSuggestion } from '@/db/schema';
import type { Database } from '@/lib/db';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import type { CheckedCandidate, DiscoveryResult } from '@/lib/onboarding/discover-sources';
import { SOURCES_AUTO_ACTIVATED } from '@/lib/onboarding/limits';
import { addSource, setSourceEnabled } from '@/lib/sources/repository';

/**
 * The sources onboarding found, stored (§20), connected (§22), and changed
 * from the "Стежу за" message (§23): ✕ pauses one, ➕ connects a reserve one
 * in its place.
 *
 * A connected source is an ordinary source of the workspace: followed from
 * now on (no backlog), text-only posts included, no Radar threshold — what
 * reaches the person is the digest's pick, not a cut-off.
 */

/** Store what discovery found: the picked to connect, best first, then the reserve. */
export async function storeSuggestions(
  db: Database,
  input: { sessionId: number | null; workspaceId: number; result: Pick<DiscoveryResult, 'picked' | 'reserve'> },
): Promise<void> {
  const row = (candidate: CheckedCandidate, rank: number, state: 'picked' | 'reserve') => ({
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    platform: candidate.source.platform,
    externalId: candidate.source.externalId,
    displayName: candidate.name && !candidate.name.startsWith('site:') ? candidate.name : candidate.source.username,
    target: candidate.target,
    origin: candidate.origin,
    links: candidate.links,
    forwards: candidate.forwards,
    reason: candidate.reason,
    kind: candidate.kind,
    organization: candidate.organization,
    via: candidate.via,
    score: candidate.score,
    rank,
    state,
  });
  const rows = [
    ...input.result.picked.map((candidate, index) => row(candidate, index + 1, 'picked')),
    ...input.result.reserve.map((candidate, index) => row(candidate, input.result.picked.length + index + 1, 'reserve')),
  ];
  if (rows.length > 0) await db.insert(sourceSuggestions).values(rows);
}

/**
 * Connect the picked, and when one cannot be, the next from the reserve, up
 * to SOURCES_AUTO_ACTIVATED. Returns the connected, in order.
 */
export async function activatePicked(db: Database, input: { workspaceId: number; logger: Logger }): Promise<SourceSuggestion[]> {
  const picked = await suggestionsIn(db, input.workspaceId, ['picked']);
  for (const suggestion of picked) await activate(db, suggestion, input.logger);

  let active = await suggestionsIn(db, input.workspaceId, ['active']);
  while (active.length < SOURCES_AUTO_ACTIVATED) {
    const [next] = await suggestionsIn(db, input.workspaceId, ['reserve']);
    if (!next) break;
    await activate(db, next, input.logger);
    active = await suggestionsIn(db, input.workspaceId, ['active']);
  }
  return active;
}

/** One suggestion connected as a source — re-enabled, if the workspace had it paused. */
export async function activate(db: Database, suggestion: SourceSuggestion, logger: Logger): Promise<SourceSuggestion> {
  try {
    const { source } = await addSource(db, {
      workspaceId: suggestion.workspaceId,
      platform: suggestion.platform,
      externalId: suggestion.externalId,
      username: suggestion.platform === 'telegram' ? suggestion.externalId : suggestion.displayName,
      includeTextOnly: true,
      radarThreshold: null,
    });
    if (!source.enabled) await setSourceEnabled(db, { id: source.id, enabled: true });
    const [row] = await db
      .update(sourceSuggestions)
      .set({ state: 'active', activatedSourceId: source.id, activationError: null, updatedAt: new Date() })
      .where(eq(sourceSuggestions.id, suggestion.id))
      .returning();
    return row!;
  } catch (error) {
    logger.warn('onboarding.source_activation_failed', { suggestionId: suggestion.id, error: describeError(error) });
    const [row] = await db
      .update(sourceSuggestions)
      .set({ state: 'failed', activationError: describeError(error).slice(0, 500), updatedAt: new Date() })
      .where(eq(sourceSuggestions.id, suggestion.id))
      .returning();
    return row!;
  }
}

/** ✕: pause the source and mark the suggestion removed. Returns the best of the reserve, to offer instead. */
export async function removeSuggestion(
  db: Database,
  input: { suggestionId: number },
): Promise<{ removed: SourceSuggestion; offer: SourceSuggestion | null } | null> {
  const [suggestion] = await db.select().from(sourceSuggestions).where(eq(sourceSuggestions.id, input.suggestionId));
  if (!suggestion || suggestion.state !== 'active') return null;
  if (suggestion.activatedSourceId) await setSourceEnabled(db, { id: suggestion.activatedSourceId, enabled: false });
  const [removed] = await db
    .update(sourceSuggestions)
    .set({ state: 'removed', updatedAt: new Date() })
    .where(eq(sourceSuggestions.id, suggestion.id))
    .returning();
  const [offer] = await suggestionsIn(db, suggestion.workspaceId, ['reserve']);
  return { removed: removed!, offer: offer ?? null };
}

export async function findSuggestion(db: Database, id: number): Promise<SourceSuggestion | null> {
  const [row] = await db.select().from(sourceSuggestions).where(eq(sourceSuggestions.id, id));
  return row ?? null;
}

export async function suggestionsIn(
  db: Database,
  workspaceId: number,
  states: SourceSuggestion['state'][],
): Promise<SourceSuggestion[]> {
  return db
    .select()
    .from(sourceSuggestions)
    .where(and(eq(sourceSuggestions.workspaceId, workspaceId), inArray(sourceSuggestions.state, states)))
    .orderBy(asc(sourceSuggestions.rank), asc(sourceSuggestions.id));
}
