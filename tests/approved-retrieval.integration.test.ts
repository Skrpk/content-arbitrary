import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { asc } from 'drizzle-orm';
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
import { embedProcessedPosts, embedPublicationHistory } from '@/lib/history/embeddings/embed';
import { findSimilarApprovedPosts } from '@/lib/history/embeddings/repository';
import { ingestRadarBatch, submitRadarBackfill, waitForBatch } from '@/lib/radar/backfill';
import { RADAR_PROMPT_APPROVED, RADAR_PROMPT_BASELINE } from '@/lib/radar/prompt';
import { createRadarRun, runLiveRadar } from '@/lib/radar/shadow';
import { createTestLogger, ensureTestWorkspace } from './helpers';
import { fakeEmbedding, fakeEmbeddings } from './history-fakes';
import { fakeAnthropic, fakeBatchProvider, messageResponse, radarOutput } from './radar-fakes';

/**
 * Spotting a repeat of something the editor already approved: posts that went
 * through review are embedded, and the newest prompt shows Radar the approved
 * ones nearest to a new post — approved before it arrived, in its workspace.
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

let nextPostId = 1_790_000_000_000_000_000n;

type Status = 'published' | 'scheduled' | 'rejected' | 'awaiting_approval';

async function post(input: {
  status: Status;
  createdAt: Date;
  reviewedAt?: Date | null;
  text?: string;
  workspaceId?: number;
  rejectionReason?: 'too_minor' | 'already_covered';
}) {
  nextPostId += 1n;
  const [row] = await db
    .insert(processedPosts)
    .values({
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      xPostId: String(nextPostId),
      xPostUrl: `https://x.com/nasa/status/${nextPostId}`,
      xAuthorUsername: 'nasa',
      sourceText: input.text ?? `post ${nextPostId}`,
      status: input.status,
      telegramMethod: 'sendPhoto',
      mediaCount: 1,
      reviewedAt:
        input.reviewedAt !== undefined
          ? input.reviewedAt
          : input.status === 'awaiting_approval'
            ? null
            : new Date(input.createdAt.getTime() + 3_600_000),
      rejectionReason: input.status === 'rejected' ? (input.rejectionReason ?? 'too_minor') : null,
      createdAt: input.createdAt,
    })
    .returning();
  return row!;
}

const embedPosts = (embeddings = fakeEmbeddings().provider, workspaceId = DEFAULT_WORKSPACE_ID) =>
  embedProcessedPosts({ db, embeddings, workspaceId, logger: createTestLogger() });

describeIfDb('embedding processed posts', () => {
  it('embeds every post with text once, and reuses what a search already stored', async () => {
    await post({ status: 'published', createdAt: at('2026-05-01T00:00:00Z'), text: 'Mars sunrise' });
    await post({ status: 'rejected', createdAt: at('2026-05-02T00:00:00Z'), text: 'Rocket launch' });
    await post({ status: 'published', createdAt: at('2026-05-03T00:00:00Z'), text: '' });
    const { provider, calls } = fakeEmbeddings();

    const first = await embedPosts(provider);
    const second = await embedPosts(provider);

    expect(calls).toEqual([['Mars sunrise', 'Rocket launch']]);
    expect(first).toMatchObject({ items: 3, eligible: 2, embedded: 2, skippedNoText: 1, failed: 0 });
    expect(second).toMatchObject({ eligible: 2, alreadyEmbedded: 2, embedded: 0, requests: 0 });
    const rows = await db.select().from(radarCandidateEmbeddings);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ model: 'text-embedding-3-small', dimensions: 6, inputTokens: null });
  });
});

describeIfDb('finding similar approved posts', () => {
  const search = async (input: { before: Date; excludePostId?: number; workspaceId?: number; limit?: number }) =>
    findSimilarApprovedPosts(db, {
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      model: 'text-embedding-3-small',
      embedding: fakeEmbedding('Mars photos'),
      before: input.before,
      excludePostId: input.excludePostId ?? -1,
      limit: input.limit ?? 5,
    });

  it('returns only what the editor approved before the candidate arrived, most similar first', async () => {
    const published = await post({ status: 'published', createdAt: at('2026-05-01T00:00:00Z'), text: 'Mars sunrise' });
    const scheduled = await post({ status: 'scheduled', createdAt: at('2026-05-02T00:00:00Z'), text: 'Mars and the moon' });
    await post({ status: 'rejected', createdAt: at('2026-05-03T00:00:00Z'), text: 'Mars dust storm' });
    await post({ status: 'awaiting_approval', createdAt: at('2026-05-04T00:00:00Z'), text: 'Mars rover' });
    // Approved, but only after the candidate arrived.
    await post({
      status: 'published',
      createdAt: at('2026-05-05T00:00:00Z'),
      reviewedAt: at('2026-05-10T00:00:00Z'),
      text: 'Mars at the same instant',
    });
    await embedPosts();

    const matches = await search({ before: at('2026-05-10T00:00:00Z') });

    expect(matches.map((match) => match.processedPostId)).toEqual([published.id, scheduled.id]);
    expect(matches[0]!.similarity).toBeGreaterThan(matches[1]!.similarity);
    expect(matches[0]).toMatchObject({
      text: 'Mars sunrise',
      sourceUsername: 'nasa',
      approvedAt: at('2026-05-01T01:00:00Z'),
    });
  });

  it('never matches the candidate itself, nor another workspace’s posts, and keeps to the limit', async () => {
    const [other] = await db.insert(workspaces).values({ name: 'other' }).returning();
    await post({ status: 'published', createdAt: at('2026-05-01T00:00:00Z'), text: 'Mars', workspaceId: other!.id });
    await embedPosts(undefined, other!.id);
    const own: { id: number }[] = [];
    for (let i = 0; i < 7; i += 1) {
      own.push(await post({ status: 'published', createdAt: at(`2026-05-0${i + 1}T00:00:00Z`), text: `Mars ${i}` }));
    }
    await embedPosts();

    const matches = await search({ before: at('2026-06-01T00:00:00Z'), excludePostId: own[0]!.id });

    expect(matches).toHaveLength(5);
    const ids = matches.map((match) => match.processedPostId);
    expect(ids).not.toContain(own[0]!.id);
    expect(ids.every((id) => own.some((row) => row.id === id))).toBe(true);
  });
});

describeIfDb('Shadow Radar with similar approved posts', () => {
  const subject = (processedPostId: number, text = 'Mars photos from ESA') => ({
    workspaceId: DEFAULT_WORKSPACE_ID,
    processedPostId,
    profile: 'Space and sci-fi.',
    item: { sourceUsername: 'esa', text, media: 'text only' },
  });

  it('scores live with the baseline and the newest prompt, which is shown the approved repeat', async () => {
    await db.insert(publicationHistoryItems).values({
      workspaceId: DEFAULT_WORKSPACE_ID,
      platform: 'telegram',
      publicationKey: '-100111',
      externalId: '1',
      contentType: 'post',
      text: 'Webb sees a planet',
      publishedAt: at('2026-04-01T00:00:00Z'),
    });
    await embedPublicationHistory({ db, embeddings: fakeEmbeddings().provider, workspaceId: DEFAULT_WORKSPACE_ID });
    const approved = await post({ status: 'published', createdAt: at('2026-05-01T00:00:00Z'), text: 'APPROVED: Mars photos' });
    await post({ status: 'rejected', createdAt: at('2026-05-02T00:00:00Z'), text: 'REJECTED: Mars photos' });
    await embedPosts();
    const candidate = await post({ status: 'awaiting_approval', createdAt: new Date() });
    const { provider, requests } = fakeAnthropic(() =>
      messageResponse(
        radarOutput({
          historical_context: { relevant: true, possibly_already_covered: true, explanation: 'Вже схвалено.' },
          score: 12,
        }),
      ),
    );

    await runLiveRadar(
      createRadarRun({
        provider,
        embeddings: fakeEmbeddings().provider,
        promptVersions: [RADAR_PROMPT_BASELINE, RADAR_PROMPT_APPROVED],
      }),
      db,
      subject(candidate.id),
      createTestLogger(),
    );

    expect(requests).toHaveLength(2);
    const newest = requests.find((request) => JSON.stringify(request).includes('similar_approved'))!;
    const baseline = requests.find((request) => request !== newest)!;
    expect(JSON.stringify(baseline)).not.toContain('similar_');
    const shown = JSON.stringify(newest.messages);
    const section = shown.slice(shown.indexOf('<similar_approved>'), shown.indexOf('</similar_approved>'));
    expect(section).toContain('APPROVED: Mars photos');
    // A rejected post is among the examples, never among the approved.
    expect(section).not.toContain('REJECTED');
    expect(shown).toContain('Webb sees a planet');
    expect(newest.system as string).toContain('Similar approved posts');

    const rows = await db.select().from(radarEvaluations).orderBy(asc(radarEvaluations.promptVersion));
    expect(rows.map((row) => row.promptVersion)).toEqual([RADAR_PROMPT_BASELINE, RADAR_PROMPT_APPROVED]);
    expect(rows[0]!.historyRetrieval).toBeNull();
    expect(rows[1]!.historyRetrieval).toMatchObject({
      status: 'ok',
      approved: { status: 'ok', matches: [{ id: approved.id }] },
    });
    expect(rows[1]!.historicalAssessment).toMatchObject({ possiblyAlreadyCovered: true });
  });

  it('searches approved posts in a workspace with no publication history', async () => {
    const approved = await post({ status: 'published', createdAt: at('2026-05-01T00:00:00Z'), text: 'Mars photos' });
    await embedPosts();
    const candidate = await post({ status: 'awaiting_approval', createdAt: new Date() });
    const { provider } = fakeAnthropic(() => messageResponse(radarOutput()));
    const embeddings = fakeEmbeddings();

    await runLiveRadar(createRadarRun({ provider, embeddings: embeddings.provider }), db, subject(candidate.id), createTestLogger());

    expect(embeddings.calls).toEqual([['Mars photos from ESA']]);
    const row = (await db.select().from(radarEvaluations)).find((r) => r.promptVersion === RADAR_PROMPT_APPROVED)!;
    expect(row.historyRetrieval).toMatchObject({
      status: 'no_history',
      approved: { status: 'ok', matches: [{ id: approved.id }] },
    });
  });

  it('records why there were none when the embeddings API fails, and scores anyway', async () => {
    await post({ status: 'published', createdAt: at('2026-05-01T00:00:00Z'), text: 'Mars photos' });
    await embedPosts();
    const candidate = await post({ status: 'awaiting_approval', createdAt: new Date() });
    const { provider } = fakeAnthropic(() => messageResponse(radarOutput({ score: 55 })));

    await runLiveRadar(
      createRadarRun({ provider, embeddings: fakeEmbeddings({ fail: () => true }).provider }),
      db,
      subject(candidate.id),
      createTestLogger(),
    );

    const row = (await db.select().from(radarEvaluations)).find((r) => r.promptVersion === RADAR_PROMPT_APPROVED)!;
    expect(row).toMatchObject({ status: 'ok', score: 55 });
    expect(row.historyRetrieval).toMatchObject({ status: 'failed', approved: { status: 'failed', matches: [] } });
  });
});

describeIfDb('backfill with similar approved posts', () => {
  it('shows only approvals made before the candidate arrived, and records what was shown', async () => {
    const earlier = await post({ status: 'published', createdAt: at('2026-05-01T00:00:00Z'), text: 'EARLIER: Mars photos' });
    await post({ status: 'rejected', createdAt: at('2026-05-02T00:00:00Z') });
    const candidate = await post({
      status: 'rejected',
      rejectionReason: 'already_covered',
      createdAt: at('2026-05-10T00:00:00Z'),
      text: 'The candidate: Mars photos',
    });
    // Arrived before the candidate, approved only after it arrived.
    await post({
      status: 'published',
      createdAt: at('2026-05-09T00:00:00Z'),
      reviewedAt: at('2026-05-10T06:00:00Z'),
      text: 'LATER: Mars photos',
    });
    await embedPosts();
    const embeddings = fakeEmbeddings().provider;
    const fake = fakeBatchProvider('openai', () => ({ output: radarOutput() }));

    const submitted = await submitRadarBackfill({
      db,
      provider: fake.provider,
      embeddings,
      promptVersions: [RADAR_PROMPT_APPROVED],
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

    const request = fake.submitted.flat().find((entry) => entry.json.includes('The candidate'))!;
    expect(request.customId).toBe(`p${candidate.id}-text-v3a`);
    expect(request.json).toContain('EARLIER: Mars photos');
    expect(request.json).not.toContain('LATER');

    const [row] = (await db.select().from(radarEvaluations)).filter((r) => r.processedPostId === candidate.id);
    expect(row).toMatchObject({ promptVersion: RADAR_PROMPT_APPROVED, status: 'ok' });
    expect(row!.historyRetrieval!.approved).toMatchObject({ status: 'ok', matches: [{ id: earlier.id }] });
    expect(row!.historyRetrieval!.approved!.matches).toHaveLength(1);
  });
});
