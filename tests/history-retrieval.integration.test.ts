import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { asc, eq } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import {
  DEFAULT_WORKSPACE_ID,
  processedPosts,
  publicationHistoryEmbeddings,
  publicationHistoryImports,
  publicationHistoryItems,
  publicationHistoryProfiles,
  radarCandidateEmbeddings,
  radarEvaluations,
  workspaces,
} from '@/db/schema';
import { embedPublicationHistory } from '@/lib/history/embeddings/embed';
import { findSimilarHistoricalItems } from '@/lib/history/embeddings/repository';
import { HISTORY_RETRIEVAL_LIMIT, retrieveSimilarPublications } from '@/lib/history/embeddings/retrieval';
import { ingestRadarBatch, submitRadarBackfill, waitForBatch } from '@/lib/radar/backfill';
import { RADAR_PROMPT_BASELINE, RADAR_PROMPT_RETRIEVAL } from '@/lib/radar/prompt';

/** The baseline against history retrieval alone; the approved-posts prompt has its own suite. */
const V1_V2 = [RADAR_PROMPT_BASELINE, RADAR_PROMPT_RETRIEVAL] as const;
import { createRadarRun, runLiveRadar } from '@/lib/radar/shadow';
import { createTestLogger, ensureTestWorkspace } from './helpers';
import { fakeEmbedding, fakeEmbeddings } from './history-fakes';
import { fakeAnthropic, fakeBatchProvider, messageResponse, radarOutput } from './radar-fakes';

/**
 * Publication history → embeddings → the most similar past publications in
 * Shadow Radar's retrieval prompt: incremental, isolated by workspace and by
 * time, and never in the way of a score.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  if (!connectionString) return;
  sql = postgres(connectionString, { max: 10, prepare: false });
  db = drizzle(sql, { schema });
});

afterAll(async () => {
  if (sql) await sql.end();
});

beforeEach(async () => {
  if (!connectionString) return;
  await db.delete(radarEvaluations);
  await db.delete(radarCandidateEmbeddings);
  await db.delete(processedPosts);
  await db.delete(publicationHistoryProfiles);
  await db.delete(publicationHistoryEmbeddings);
  await db.delete(publicationHistoryItems);
  await db.delete(publicationHistoryImports);
  await ensureTestWorkspace(db);
});

const at = (iso: string) => new Date(iso);

let nextExternalId = 1;

async function historyItem(input: {
  text: string | null;
  publishedAt: Date;
  workspaceId?: number;
  title?: string | null;
}) {
  const [row] = await db
    .insert(publicationHistoryItems)
    .values({
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      platform: 'telegram',
      publicationKey: '-100111',
      externalId: String(nextExternalId++),
      contentType: 'post',
      title: input.title ?? null,
      text: input.text,
      publishedAt: input.publishedAt,
      media: input.text === null ? [{ type: 'photo', relativePath: null, available: false }] : [],
    })
    .returning();
  return row!;
}

const embedAll = (embeddings = fakeEmbeddings().provider, workspaceId = DEFAULT_WORKSPACE_ID) =>
  embedPublicationHistory({ db, embeddings, workspaceId, logger: createTestLogger() });

const storedVectors = () =>
  db.select().from(publicationHistoryEmbeddings).orderBy(asc(publicationHistoryEmbeddings.publicationHistoryItemId));

describeIfDb('embedding publication history', () => {
  it('embeds every item with text, records the model and fingerprint, and leaves photo-only items be', async () => {
    const mars = await historyItem({ title: 'Mars Express', text: 'Mars from orbit', publishedAt: at('2026-04-01T10:00:00Z') });
    const webb = await historyItem({ text: 'Webb sees a planet', publishedAt: at('2026-04-02T10:00:00Z') });
    await historyItem({ text: null, publishedAt: at('2026-04-03T10:00:00Z') });
    const { provider, calls } = fakeEmbeddings();

    const summary = await embedAll(provider);

    expect(summary).toMatchObject({
      model: 'text-embedding-3-small',
      items: 3,
      eligible: 2,
      alreadyEmbedded: 0,
      embedded: 2,
      reembedded: 0,
      skippedNoText: 1,
      failed: 0,
      requests: 1,
    });
    expect(summary.inputTokens).toBeGreaterThan(0);
    // Title and text, nothing else: no ids, dates or platform.
    expect(calls).toEqual([['Mars Express\n\nMars from orbit', 'Webb sees a planet']]);

    const rows = await storedVectors();
    expect(rows.map((row) => row.publicationHistoryItemId)).toEqual([mars.id, webb.id]);
    expect(rows[0]).toMatchObject({ model: 'text-embedding-3-small', dimensions: 6 });
    expect(rows[0]!.contentFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.embedding).toEqual(fakeEmbedding('Mars Express\n\nMars from orbit'));
  });

  it('does not embed an unchanged item again', async () => {
    await historyItem({ text: 'Mars from orbit', publishedAt: at('2026-04-01T10:00:00Z') });
    await embedAll();
    const before = await storedVectors();
    const { provider, calls } = fakeEmbeddings();

    const summary = await embedAll(provider);

    expect(calls).toEqual([]);
    expect(summary).toMatchObject({ eligible: 1, alreadyEmbedded: 1, embedded: 0, reembedded: 0, requests: 0, inputTokens: 0 });
    expect(await storedVectors()).toEqual(before);
  });

  it('after a new import, embeds only the new and the changed items', async () => {
    await historyItem({ text: 'Mars from orbit', publishedAt: at('2026-04-01T10:00:00Z') });
    const edited = await historyItem({ text: 'Moon landing site', publishedAt: at('2026-04-02T10:00:00Z') });
    const captionRemoved = await historyItem({ text: 'Rocket on the pad', publishedAt: at('2026-04-03T10:00:00Z') });
    await embedAll();

    // What a later import does: one post edited, one stripped to its photo, one new.
    await db.update(publicationHistoryItems).set({ text: 'Moon landing site, now in colour' }).where(eq(publicationHistoryItems.id, edited.id));
    await db.update(publicationHistoryItems).set({ text: null }).where(eq(publicationHistoryItems.id, captionRemoved.id));
    const added = await historyItem({ text: 'Webb sees a planet', publishedAt: at('2026-04-04T10:00:00Z') });
    const { provider, calls } = fakeEmbeddings();

    const summary = await embedAll(provider);

    expect(calls).toEqual([['Moon landing site, now in colour', 'Webb sees a planet']]);
    expect(summary).toMatchObject({ eligible: 3, alreadyEmbedded: 1, embedded: 1, reembedded: 1, skippedNoText: 1, removedStale: 1 });
    const rows = await storedVectors();
    expect(rows.map((row) => row.publicationHistoryItemId).sort()).toEqual(
      [rows[0]!.publicationHistoryItemId, edited.id, added.id].sort(),
    );
    expect(rows.find((row) => row.publicationHistoryItemId === edited.id)!.embedding).toEqual(
      fakeEmbedding('Moon landing site, now in colour'),
    );
  });

  it('keeps vectors of different models apart, and embeds for a new model from scratch', async () => {
    await historyItem({ text: 'Mars from orbit', publishedAt: at('2026-04-01T10:00:00Z') });
    await embedAll();
    const large = fakeEmbeddings({ model: 'text-embedding-3-large' });

    const summary = await embedAll(large.provider);

    expect(summary).toMatchObject({ model: 'text-embedding-3-large', embedded: 1, alreadyEmbedded: 0 });
    expect((await storedVectors()).map((row) => row.model).sort()).toEqual(['text-embedding-3-large', 'text-embedding-3-small']);
  });

  it('counts a failed request, stores nothing for it, and leaves it for the next run', async () => {
    await historyItem({ text: 'Mars from orbit', publishedAt: at('2026-04-01T10:00:00Z') });
    const logger = createTestLogger();

    const summary = await embedPublicationHistory({
      db,
      embeddings: fakeEmbeddings({ fail: () => true }).provider,
      workspaceId: DEFAULT_WORKSPACE_ID,
      logger,
    });

    expect(summary).toMatchObject({ eligible: 1, embedded: 0, failed: 1 });
    expect(await storedVectors()).toEqual([]);
    expect(logger.entries.some((entry) => entry.event === 'history.embed_request_failed')).toBe(true);
    expect((await embedAll()).embedded).toBe(1);
  });

  it('counts without calling anything on a dry run', async () => {
    await historyItem({ text: 'Mars from orbit', publishedAt: at('2026-04-01T10:00:00Z') });
    const { provider, calls } = fakeEmbeddings();

    const summary = await embedPublicationHistory({ db, embeddings: provider, workspaceId: DEFAULT_WORKSPACE_ID, dryRun: true });

    expect(summary).toMatchObject({ eligible: 1, embedded: 1 });
    expect(calls).toEqual([]);
    expect(await storedVectors()).toEqual([]);
  });
});

describeIfDb('finding similar past publications', () => {
  const search = (input: { before: Date; workspaceId?: number; limit?: number; text?: string; model?: string }) =>
    findSimilarHistoricalItems(db, {
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      model: input.model ?? 'text-embedding-3-small',
      embedding: fakeEmbedding(input.text ?? 'ESA mars photos'),
      before: input.before,
      limit: input.limit ?? HISTORY_RETRIEVAL_LIMIT,
    });

  it('returns the most similar first, with the item itself', async () => {
    const webb = await historyItem({ text: 'Webb sees a planet', publishedAt: at('2026-04-01T10:00:00Z') });
    const mars = await historyItem({ title: 'Mars', text: 'Mars panorama', publishedAt: at('2026-04-02T10:00:00Z') });
    const marsAndMoon = await historyItem({ text: 'Mars and the moon', publishedAt: at('2026-04-03T10:00:00Z') });
    await embedAll();

    const matches = await search({ before: at('2026-05-10T00:00:00Z') });

    expect(matches.map((match) => match.itemId)).toEqual([mars.id, marsAndMoon.id, webb.id]);
    expect(matches[0]!.similarity).toBeGreaterThan(matches[1]!.similarity);
    expect(matches[1]!.similarity).toBeGreaterThan(matches[2]!.similarity);
    expect(matches[0]!.similarity).toBeCloseTo(1, 5);
    expect(matches[0]).toMatchObject({
      title: 'Mars',
      text: 'Mars panorama',
      platform: 'telegram',
      contentType: 'post',
      publishedAt: at('2026-04-02T10:00:00Z'),
      canonicalUrl: null,
    });
  });

  it('returns at most the limit', async () => {
    for (let i = 0; i < 8; i += 1) await historyItem({ text: `Mars ${i}`, publishedAt: at(`2026-04-0${i + 1}T10:00:00Z`) });
    await embedAll();

    expect(await search({ before: at('2026-05-10T00:00:00Z') })).toHaveLength(5);
    expect(await search({ before: at('2026-05-10T00:00:00Z'), limit: 2 })).toHaveLength(2);
  });

  it('never sees a publication from the candidate’s future, or from the very moment it arrived', async () => {
    const earlier = await historyItem({ text: 'Mars from orbit', publishedAt: at('2026-05-09T23:59:00Z') });
    await historyItem({ text: 'Mars from orbit, the next day', publishedAt: at('2026-05-11T08:00:00Z') });
    await historyItem({ text: 'Mars at the same instant', publishedAt: at('2026-05-10T00:00:00Z') });
    await embedAll();

    const matches = await search({ before: at('2026-05-10T00:00:00Z') });

    expect(matches.map((match) => match.itemId)).toEqual([earlier.id]);
  });

  it('never sees another workspace’s history', async () => {
    const [other] = await db.insert(workspaces).values({ name: 'other' }).returning();
    await historyItem({ text: 'Mars from orbit', publishedAt: at('2026-04-01T10:00:00Z'), workspaceId: other!.id });
    await embedAll(undefined, other!.id);
    const own = await historyItem({ text: 'Webb sees a planet', publishedAt: at('2026-04-01T10:00:00Z') });
    await embedAll();

    const matches = await search({ before: at('2026-05-10T00:00:00Z') });

    expect(matches.map((match) => match.itemId)).toEqual([own.id]);
    expect(await search({ before: at('2026-05-10T00:00:00Z'), workspaceId: other!.id })).toHaveLength(1);
  });

  it('only compares vectors of the same model', async () => {
    await historyItem({ text: 'Mars from orbit', publishedAt: at('2026-04-01T10:00:00Z') });
    await embedAll(fakeEmbeddings({ model: 'text-embedding-3-large' }).provider);

    expect(await search({ before: at('2026-05-10T00:00:00Z') })).toEqual([]);
    expect(await search({ before: at('2026-05-10T00:00:00Z'), model: 'text-embedding-3-large' })).toHaveLength(1);
  });

  it('skips a vector of another length rather than failing the search', async () => {
    const short = await historyItem({ text: 'Mars, shortened', publishedAt: at('2026-04-01T10:00:00Z') });
    const full = await historyItem({ text: 'Mars from orbit', publishedAt: at('2026-04-02T10:00:00Z') });
    await embedAll();
    // Same model asked for fewer dimensions: pgvector refuses to compare the two.
    await db
      .update(publicationHistoryEmbeddings)
      .set({ embedding: [1, 0, 0], dimensions: 3 })
      .where(eq(publicationHistoryEmbeddings.publicationHistoryItemId, short.id));

    const matches = await search({ before: at('2026-05-10T00:00:00Z') });

    expect(matches.map((match) => match.itemId)).toEqual([full.id]);
  });
});

// ---------------------------------------------------------------------------

let nextPostId = 1_780_000_000_000_000_000n;

async function post(input: {
  decision: 'approve' | 'reject' | 'pending';
  createdAt: Date;
  text?: string;
  rejectionReason?: 'too_minor' | 'already_covered';
  workspaceId?: number;
}) {
  nextPostId += 1n;
  const [row] = await db
    .insert(processedPosts)
    .values({
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      xPostId: String(nextPostId),
      xPostUrl: `https://x.com/esa/status/${nextPostId}`,
      xAuthorUsername: 'esa',
      sourceText: input.text ?? `post ${nextPostId}`,
      status: input.decision === 'approve' ? 'published' : input.decision === 'reject' ? 'rejected' : 'awaiting_approval',
      telegramMethod: 'sendPhoto',
      mediaCount: 1,
      reviewedAt: input.decision === 'pending' ? null : new Date(input.createdAt.getTime() + 3_600_000),
      rejectionReason: input.decision === 'reject' ? (input.rejectionReason ?? 'too_minor') : null,
      createdAt: input.createdAt,
    })
    .returning();
  return row!;
}

describe('retrieval never stands in the way', () => {
  it.runIf(connectionString)('skips a post without text, without calling the API', async () => {
    await historyItem({ text: 'Mars from orbit', publishedAt: at('2026-04-01T10:00:00Z') });
    await embedAll();
    const candidate = await post({ decision: 'pending', createdAt: at('2026-05-10T00:00:00Z'), text: '' });
    const { provider, calls } = fakeEmbeddings();

    const result = await retrieveSimilarPublications({
      db,
      embeddings: provider,
      workspaceId: DEFAULT_WORKSPACE_ID,
      processedPostId: candidate.id,
      candidateText: '  ',
      before: candidate.createdAt,
    });

    expect(result).toMatchObject({ status: 'no_text', matches: [] });
    expect(calls).toEqual([]);
  });

  it.runIf(connectionString)('costs nothing for a workspace with no history', async () => {
    const candidate = await post({ decision: 'pending', createdAt: at('2026-05-10T00:00:00Z'), text: 'Mars' });
    const { provider, calls } = fakeEmbeddings();

    const result = await retrieveSimilarPublications({
      db,
      embeddings: provider,
      workspaceId: DEFAULT_WORKSPACE_ID,
      processedPostId: candidate.id,
      candidateText: 'Mars',
      before: candidate.createdAt,
    });

    expect(result).toMatchObject({ status: 'no_history', matches: [], embeddingModel: 'text-embedding-3-small' });
    expect(calls).toEqual([]);
  });

  it.runIf(connectionString)('reports a failure instead of throwing it', async () => {
    await historyItem({ text: 'Mars from orbit', publishedAt: at('2026-04-01T10:00:00Z') });
    await embedAll();
    const candidate = await post({ decision: 'pending', createdAt: at('2026-05-10T00:00:00Z'), text: 'Mars' });
    const logger = createTestLogger();

    const result = await retrieveSimilarPublications({
      db,
      embeddings: fakeEmbeddings({ fail: () => true }).provider,
      workspaceId: DEFAULT_WORKSPACE_ID,
      processedPostId: candidate.id,
      candidateText: 'Mars',
      before: candidate.createdAt,
      logger,
    });

    expect(result).toMatchObject({ status: 'failed', matches: [], error: expect.stringContaining('embeddings API is down') });
    expect(logger.entries.some((entry) => entry.event === 'radar.history_retrieval_failed')).toBe(true);
  });

  it.runIf(connectionString)('embeds a post once, and reuses its vector', async () => {
    await historyItem({ text: 'Mars from orbit', publishedAt: at('2026-04-01T10:00:00Z') });
    await embedAll();
    const candidate = await post({ decision: 'pending', createdAt: at('2026-05-10T00:00:00Z'), text: 'Mars' });
    const { provider, calls } = fakeEmbeddings();
    const retrieve = () =>
      retrieveSimilarPublications({
        db,
        embeddings: provider,
        workspaceId: DEFAULT_WORKSPACE_ID,
        processedPostId: candidate.id,
        candidateText: 'Mars',
        before: candidate.createdAt,
      });

    const first = await retrieve();
    const second = await retrieve();

    expect(calls).toEqual([['Mars']]);
    expect(first.inputTokens).toBeGreaterThan(0);
    expect(second).toMatchObject({ status: 'ok', inputTokens: 0, matches: first.matches });
  });
});

describeIfDb('Shadow Radar with similar past publications', () => {
  const subject = (processedPostId: number, text = 'ESA: new Mars photos') => ({
    workspaceId: DEFAULT_WORKSPACE_ID,
    processedPostId,
    profile: 'Space and sci-fi.',
    item: { sourceUsername: 'esa', text, media: 'text only' },
  });

  const withContext = radarOutput({
    historical_context: { relevant: true, possibly_already_covered: false, explanation: 'Нова подія, не повтор.' },
  });

  async function liveSetup() {
    const mars = await historyItem({ text: 'Mars Express: new Mars images', publishedAt: at('2026-04-01T10:00:00Z') });
    const webb = await historyItem({ text: 'Webb sees a planet', publishedAt: at('2026-04-02T10:00:00Z') });
    await embedAll();
    const candidate = await post({ decision: 'pending', createdAt: new Date() });
    return { mars, webb, candidate };
  }

  it('scores with both prompts, shows the retrieval one the matches, and records what it saw', async () => {
    const { mars, webb, candidate } = await liveSetup();
    const { provider, requests } = fakeAnthropic(() => messageResponse(withContext));
    const embeddings = fakeEmbeddings();

    await runLiveRadar(createRadarRun({ promptVersions: V1_V2, provider, embeddings: embeddings.provider }), db, subject(candidate.id), createTestLogger());

    expect(requests).toHaveLength(2);
    const [baseline, retrieval] = [...requests].sort((a, b) =>
      JSON.stringify(a).includes('similar_publications') ? 1 : JSON.stringify(b).includes('similar_publications') ? -1 : 0,
    );
    expect(JSON.stringify(baseline)).not.toContain('similar_publications');
    expect(baseline!.system as string).not.toContain('historical_context');
    const shown = JSON.stringify(retrieval!.messages);
    expect(shown).toContain('Mars Express: new Mars images');
    expect(shown.indexOf('Mars Express')).toBeLessThan(shown.indexOf('Webb sees a planet'));
    expect(embeddings.calls).toEqual([['ESA: new Mars photos']]);

    const rows = await db.select().from(radarEvaluations).orderBy(asc(radarEvaluations.promptVersion));
    expect(rows.map((row) => [row.promptVersion, row.status])).toEqual([
      [RADAR_PROMPT_BASELINE, 'ok'],
      [RADAR_PROMPT_RETRIEVAL, 'ok'],
    ]);
    expect(rows[0]).toMatchObject({ historyRetrieval: null, historicalAssessment: null });
    expect(rows[1]!.historyRetrieval).toMatchObject({
      status: 'ok',
      embeddingModel: 'text-embedding-3-small',
      matches: [{ id: mars.id }, { id: webb.id }],
    });
    expect(rows[1]!.historyRetrieval!.matches[0]!.similarity).toBeGreaterThan(rows[1]!.historyRetrieval!.matches[1]!.similarity);
    expect(rows[1]!.historicalAssessment).toEqual({
      relevant: true,
      possiblyAlreadyCovered: false,
      explanation: 'Нова подія, не повтор.',
    });
  });

  it('still scores both when the embeddings API fails, and records why there were no matches', async () => {
    const { candidate } = await liveSetup();
    const { provider, requests } = fakeAnthropic(() => messageResponse(radarOutput({ score: 61 })));

    await runLiveRadar(
      createRadarRun({ promptVersions: V1_V2, provider, embeddings: fakeEmbeddings({ fail: () => true }).provider }),
      db,
      subject(candidate.id),
      createTestLogger(),
    );

    expect(requests).toHaveLength(2);
    const rows = await db.select().from(radarEvaluations).orderBy(asc(radarEvaluations.promptVersion));
    expect(rows.map((row) => [row.status, row.score])).toEqual([
      ['ok', 61],
      ['ok', 61],
    ]);
    expect(rows[1]!.historyRetrieval).toMatchObject({ status: 'failed', matches: [], error: expect.stringContaining('embeddings API is down') });
  });

  it('works as before for a workspace with no history, or without embeddings configured', async () => {
    const candidate = await post({ decision: 'pending', createdAt: new Date() });
    const { provider } = fakeAnthropic(() => messageResponse(radarOutput()));

    await runLiveRadar(createRadarRun({ promptVersions: V1_V2, provider, embeddings: fakeEmbeddings().provider }), db, subject(candidate.id), createTestLogger());
    const other = await post({ decision: 'pending', createdAt: new Date() });
    await runLiveRadar(createRadarRun({ promptVersions: V1_V2, provider }), db, subject(other.id), createTestLogger());

    const retrievalRows = (await db.select().from(radarEvaluations)).filter(
      (row) => row.promptVersion === RADAR_PROMPT_RETRIEVAL,
    );
    expect(retrievalRows.map((row) => [row.processedPostId, row.status, row.historyRetrieval?.status]).sort()).toEqual(
      [
        [candidate.id, 'ok', 'no_history'],
        [other.id, 'ok', 'unavailable'],
      ].sort(),
    );
  });

  it('does not search for a post without text', async () => {
    await liveSetup();
    const candidate = await post({ decision: 'pending', createdAt: new Date(), text: '' });
    const { provider } = fakeAnthropic(() => messageResponse(radarOutput()));
    const embeddings = fakeEmbeddings();

    await runLiveRadar(createRadarRun({ promptVersions: V1_V2, provider, embeddings: embeddings.provider }), db, subject(candidate.id, ''), createTestLogger());

    expect(embeddings.calls).toEqual([]);
    const row = (await db.select().from(radarEvaluations)).find((r) => r.promptVersion === RADAR_PROMPT_RETRIEVAL)!;
    expect(row).toMatchObject({ status: 'ok', historyRetrieval: { status: 'no_text', matches: [] } });
  });

  it('never shows one tenant another’s history', async () => {
    const [other] = await db.insert(workspaces).values({ name: 'other', editorialProfile: 'Other.' }).returning();
    await historyItem({ text: 'OTHER TENANT Mars Mars Mars', publishedAt: at('2026-04-01T10:00:00Z'), workspaceId: other!.id });
    await embedAll(undefined, other!.id);
    const own = await historyItem({ text: 'Webb sees a planet', publishedAt: at('2026-04-01T10:00:00Z') });
    await embedAll();
    const candidate = await post({ decision: 'pending', createdAt: new Date() });
    const { provider, requests } = fakeAnthropic(() => messageResponse(radarOutput()));

    await runLiveRadar(createRadarRun({ promptVersions: V1_V2, provider, embeddings: fakeEmbeddings().provider }), db, subject(candidate.id), createTestLogger());

    expect(JSON.stringify(requests)).not.toContain('OTHER TENANT');
    const row = (await db.select().from(radarEvaluations)).find((r) => r.promptVersion === RADAR_PROMPT_RETRIEVAL)!;
    expect(row.historyRetrieval!.matches.map((match) => match.id)).toEqual([own.id]);
  });
});

describeIfDb('backfill with similar past publications', () => {
  async function scenario() {
    // Decisions behind the candidate, so it is scored at all.
    await post({ decision: 'approve', createdAt: at('2026-05-01T00:00:00Z') });
    await post({ decision: 'reject', createdAt: at('2026-05-02T00:00:00Z') });
    const candidate = await post({
      decision: 'reject',
      rejectionReason: 'already_covered',
      createdAt: at('2026-05-10T00:00:00Z'),
      text: 'The candidate: ESA Mars photos',
    });
    const before = await historyItem({ text: 'PAST: Mars Express images', publishedAt: at('2026-05-09T12:00:00Z') });
    // The channel ran the same story the day after the candidate arrived.
    const after = await historyItem({ text: 'FUTURE: ESA Mars photos, as published', publishedAt: at('2026-05-11T08:00:00Z') });
    await embedAll();
    return { candidate, before, after };
  }

  async function run(embeddings = fakeEmbeddings().provider) {
    const fake = fakeBatchProvider('openai', (request) => ({
      output: request.customId.endsWith('-v2r')
        ? radarOutput({
            historical_context: { relevant: true, possibly_already_covered: true, explanation: 'Те саме.' },
            score: 15,
          })
        : radarOutput({ score: 70 }),
    }));
    const submitted = await submitRadarBackfill({
      promptVersions: V1_V2,
      db,
      provider: fake.provider,
      embeddings,
      workspaceId: DEFAULT_WORKSPACE_ID,
      profile: 'Space.',
      minPerClass: 1,
      logger: createTestLogger(),
    });
    for (const batchId of submitted.batchIds) {
      await waitForBatch(fake.provider, batchId, { pollMs: 0, sleep: async () => {} });
      await ingestRadarBatch({
        db,
        provider: fake.provider,
        batchId,
        workspaceId: DEFAULT_WORKSPACE_ID,
        embeddingModel: embeddings.model,
        logger: createTestLogger(),
      });
    }
    return { fake, submitted };
  }

  it('scores both prompts in one batch, and the retrieval one never sees the future', async () => {
    const { candidate, before, after } = await scenario();

    const { fake, submitted } = await run();

    const requests = fake.submitted.flat().filter((entry) => entry.json.includes('The candidate'));
    expect(requests.map((entry) => entry.customId).sort()).toEqual([`p${candidate.id}-text`, `p${candidate.id}-text-v2r`]);
    const retrieval = requests.find((entry) => entry.customId.endsWith('-v2r'))!;
    expect(retrieval.json).toContain('PAST: Mars Express images');
    expect(retrieval.json).not.toContain('FUTURE');
    expect(requests.find((entry) => !entry.customId.endsWith('-v2r'))!.json).not.toContain('similar_publications');
    expect(submitted.retrievalFailed).toBe(0);

    const rows = (await db.select().from(radarEvaluations).orderBy(asc(radarEvaluations.promptVersion))).filter(
      (row) => row.processedPostId === candidate.id,
    );
    expect(rows.map((row) => [row.promptVersion, row.status, row.score])).toEqual([
      [RADAR_PROMPT_BASELINE, 'ok', 70],
      [RADAR_PROMPT_RETRIEVAL, 'ok', 15],
    ]);
    expect(rows[0]!.historyRetrieval).toBeNull();
    // What was recorded is what the request was built from: the past item only.
    expect(rows[1]!.historyRetrieval).toMatchObject({ status: 'ok', matches: [{ id: before.id }] });
    expect(rows[1]!.historyRetrieval!.matches.map((match) => match.id)).not.toContain(after.id);
    expect(rows[1]!.historicalAssessment).toMatchObject({ possiblyAlreadyCovered: true });
  });

  it('holds back the retrieval prompt for a post whose search failed, and retries it next time', async () => {
    const { candidate } = await scenario();

    const first = await run(fakeEmbeddings({ fail: () => true }).provider);

    expect(first.submitted.retrievalFailed).toBeGreaterThan(0);
    let rows = (await db.select().from(radarEvaluations)).filter((row) => row.processedPostId === candidate.id);
    expect(rows.map((row) => row.promptVersion)).toEqual([RADAR_PROMPT_BASELINE]);

    await run();

    rows = (await db.select().from(radarEvaluations)).filter((row) => row.processedPostId === candidate.id);
    expect(rows.map((row) => row.promptVersion).sort()).toEqual([RADAR_PROMPT_BASELINE, RADAR_PROMPT_RETRIEVAL]);
  });
});
