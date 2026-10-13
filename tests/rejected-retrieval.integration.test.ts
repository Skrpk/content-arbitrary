import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
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
import { embedProcessedPosts } from '@/lib/history/embeddings/embed';
import { findSimilarRejectedPosts } from '@/lib/history/embeddings/repository';
import { ingestRadarBatch, submitRadarBackfill, waitForBatch } from '@/lib/radar/backfill';
import { RADAR_PROMPT_APPROVED, RADAR_PROMPT_NEAREST, RADAR_PROMPT_REJECTED } from '@/lib/radar/prompt';
import { createRadarRun, runLiveRadar } from '@/lib/radar/shadow';
import { createTestLogger, ensureTestWorkspace } from './helpers';
import { fakeEmbedding, fakeEmbeddings } from './history-fakes';
import { fakeAnthropic, fakeBatchProvider, messageResponse, radarOutput } from './radar-fakes';

/**
 * Learning what the editor keeps turning down: the newest prompt shows Radar
 * the rejected posts nearest to a new one — rejected before it arrived, in
 * its workspace — with the reason and note the editor gave.
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

let nextPostId = 1_791_000_000_000_000_000n;

type Status = 'published' | 'rejected' | 'awaiting_approval';

async function post(input: {
  status: Status;
  createdAt: Date;
  reviewedAt?: Date | null;
  text?: string;
  workspaceId?: number;
  rejectionNote?: string;
}) {
  nextPostId += 1n;
  const [row] = await db
    .insert(processedPosts)
    .values({
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      externalId: String(nextPostId),
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
      rejectionReason: input.status === 'rejected' ? 'not_interesting' : null,
      rejectionNote: input.status === 'rejected' ? (input.rejectionNote ?? null) : null,
      createdAt: input.createdAt,
    })
    .returning();
  return row!;
}

const embedPosts = (workspaceId = DEFAULT_WORKSPACE_ID) =>
  embedProcessedPosts({ db, embeddings: fakeEmbeddings().provider, workspaceId, logger: createTestLogger() });

describeIfDb('finding similar rejected posts', () => {
  const search = async (input: { before: Date; excludePostId?: number; limit?: number }) =>
    findSimilarRejectedPosts(db, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      model: 'text-embedding-3-small',
      embedding: fakeEmbedding('Galaxy photos'),
      before: input.before,
      excludePostId: input.excludePostId ?? -1,
      limit: input.limit ?? 5,
    });

  it('returns only what the editor rejected before the candidate arrived, with the reason and note', async () => {
    const rejected = await post({
      status: 'rejected',
      createdAt: at('2026-05-01T00:00:00Z'),
      text: 'Galaxy swirl',
      rejectionNote: 'just a pretty picture',
    });
    await post({ status: 'published', createdAt: at('2026-05-02T00:00:00Z'), text: 'Galaxy merger found' });
    await post({ status: 'awaiting_approval', createdAt: at('2026-05-03T00:00:00Z'), text: 'Galaxy cluster' });
    // Rejected, but only after the candidate arrived.
    await post({
      status: 'rejected',
      createdAt: at('2026-05-04T00:00:00Z'),
      reviewedAt: at('2026-05-10T00:00:00Z'),
      text: 'Galaxy at the same instant',
    });
    const [other] = await db.insert(workspaces).values({ name: 'other' }).returning();
    await post({ status: 'rejected', createdAt: at('2026-05-01T00:00:00Z'), text: 'Galaxy', workspaceId: other!.id });
    await embedPosts(other!.id);
    await embedPosts();

    const matches = await search({ before: at('2026-05-10T00:00:00Z') });

    expect(matches.map((match) => match.processedPostId)).toEqual([rejected.id]);
    expect(matches[0]).toMatchObject({
      text: 'Galaxy swirl',
      sourceUsername: 'nasa',
      rejectedAt: at('2026-05-01T01:00:00Z'),
      rejectionReason: 'not_interesting',
      rejectionNote: 'just a pretty picture',
    });
    expect(await search({ before: at('2026-05-10T00:00:00Z'), excludePostId: rejected.id })).toEqual([]);
  });
});

describeIfDb('Shadow Radar with similar rejected posts', () => {
  it('shows v5 the rejected posts beside the approved ones, and v3 none of the rejected', async () => {
    const approved = await post({ status: 'published', createdAt: at('2026-05-01T00:00:00Z'), text: 'APPROVED: galaxy merger' });
    const rejected = await post({
      status: 'rejected',
      createdAt: at('2026-05-02T00:00:00Z'),
      text: 'REJECTED: galaxy swirl',
      rejectionNote: 'just a pretty picture',
    });
    await embedPosts();
    const candidate = await post({ status: 'awaiting_approval', createdAt: new Date() });
    const { provider, requests } = fakeAnthropic(() => messageResponse(radarOutput({ score: 20 })));

    await runLiveRadar(
      createRadarRun({
        provider,
        embeddings: fakeEmbeddings().provider,
        promptVersions: [RADAR_PROMPT_APPROVED, RADAR_PROMPT_REJECTED],
      }),
      db,
      {
        workspaceId: DEFAULT_WORKSPACE_ID,
        processedPostId: candidate.id,
        profile: 'Space news.',
        item: { sourceUsername: 'esa', text: 'A beautiful galaxy', media: 'photo' },
      },
      createTestLogger(),
    );

    expect(requests).toHaveLength(2);
    const v5 = requests.find((request) => JSON.stringify(request.messages).includes('<similar_rejected>'))!;
    const v3 = requests.find((request) => request !== v5)!;
    expect(JSON.stringify(v3)).not.toContain('similar_rejected');
    const shown = JSON.stringify(v5.messages);
    const section = shown.slice(shown.indexOf('<similar_rejected>'), shown.indexOf('</similar_rejected>'));
    expect(section).toContain('REJECTED: galaxy swirl');
    expect(section).toContain('reason=\\"not_interesting\\"');
    expect(section).toContain("editor's note: just a pretty picture");
    expect(section).not.toContain('APPROVED');
    expect(shown).toContain('<similar_approved>');
    expect(v5.system as string).toContain('Similar rejected posts');

    const rows = await db.select().from(radarEvaluations);
    const v3Row = rows.find((row) => row.promptVersion === RADAR_PROMPT_APPROVED)!;
    const v5Row = rows.find((row) => row.promptVersion === RADAR_PROMPT_REJECTED)!;
    expect(v3Row.historyRetrieval!.rejected).toBeUndefined();
    expect(v5Row.mediaUnderstandingId).toBeNull();
    expect(v5Row.historyRetrieval).toMatchObject({
      approved: { status: 'ok', matches: [{ id: approved.id }] },
      rejected: { status: 'ok', matches: [{ id: rejected.id }] },
    });
  });
});

describeIfDb('Shadow Radar with the nearest decisions', () => {
  it('shows v6 the nearest approved and rejected posts together, most similar first, and records them', async () => {
    const approved = await post({ status: 'published', createdAt: at('2026-05-01T00:00:00Z'), text: 'APPROVED: galaxy merger' });
    const rejected: { id: number }[] = [];
    for (let i = 0; i < 12; i += 1) {
      rejected.push(
        await post({ status: 'rejected', createdAt: at(`2026-05-${String(i + 2).padStart(2, '0')}T00:00:00Z`), text: `REJECTED: galaxy ${i}` }),
      );
    }
    await embedPosts();
    const candidate = await post({ status: 'awaiting_approval', createdAt: new Date() });
    const { provider, requests } = fakeAnthropic(() => messageResponse(radarOutput({ score: 30 })));

    await runLiveRadar(
      createRadarRun({ provider, embeddings: fakeEmbeddings().provider, promptVersions: [RADAR_PROMPT_NEAREST] }),
      db,
      {
        workspaceId: DEFAULT_WORKSPACE_ID,
        processedPostId: candidate.id,
        profile: 'Space news.',
        item: { sourceUsername: 'esa', text: 'A beautiful galaxy', media: 'photo' },
      },
      createTestLogger(),
    );

    const shown = JSON.stringify(requests[0]!.messages);
    const section = shown.slice(shown.indexOf('<nearest_decisions>'), shown.indexOf('</nearest_decisions>'));
    expect(section.match(/<decision /g)).toHaveLength(10);
    // The v3 list of approved posts is still there, for telling repeats.
    expect(shown).toContain('<similar_approved>');
    expect(shown).not.toContain('<similar_rejected>');

    const [row] = await db.select().from(radarEvaluations);
    const nearest = row!.historyRetrieval!.nearest!;
    expect(nearest.status).toBe('ok');
    expect(nearest.matches).toHaveLength(10);
    const similarities = nearest.matches.map((match) => match.similarity);
    expect(similarities).toEqual([...similarities].sort((a, b) => b - a));
    const ids = nearest.matches.map((match) => match.id);
    expect(ids.every((id) => id === approved.id || rejected.some((post) => post.id === id))).toBe(true);
    expect(row!.historyRetrieval!.approved).toMatchObject({ status: 'ok', matches: [{ id: approved.id }] });
    // The approved post is among the nearest exactly when it is nearer than the tenth rejected one.
    const tenth = similarities[9]!;
    expect(ids.includes(approved.id)).toBe(row!.historyRetrieval!.approved!.matches[0]!.similarity >= tenth);
  });
});

describeIfDb('backfill with similar rejected posts', () => {
  it('shows only rejections made before the candidate arrived, and records what was shown', async () => {
    const earlier = await post({ status: 'rejected', createdAt: at('2026-05-01T00:00:00Z'), text: 'EARLIER: galaxy photo' });
    await post({ status: 'published', createdAt: at('2026-05-02T00:00:00Z') });
    const candidate = await post({
      status: 'rejected',
      createdAt: at('2026-05-10T00:00:00Z'),
      text: 'The candidate: galaxy photo',
    });
    // Arrived before the candidate, rejected only after it arrived.
    await post({
      status: 'rejected',
      createdAt: at('2026-05-09T00:00:00Z'),
      reviewedAt: at('2026-05-10T06:00:00Z'),
      text: 'LATER: galaxy photo',
    });
    await embedPosts();
    const embeddings = fakeEmbeddings().provider;
    const fake = fakeBatchProvider('openai', () => ({ output: radarOutput() }));

    const submitted = await submitRadarBackfill({
      db,
      provider: fake.provider,
      embeddings,
      promptVersions: [RADAR_PROMPT_REJECTED],
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
    expect(request.customId).toBe(`p${candidate.id}-text-v5r`);
    expect(request.json).toContain('EARLIER: galaxy photo');
    expect(request.json).not.toContain('LATER');

    const [row] = (await db.select().from(radarEvaluations)).filter((r) => r.processedPostId === candidate.id);
    expect(row).toMatchObject({ promptVersion: RADAR_PROMPT_REJECTED, status: 'ok' });
    expect(row!.historyRetrieval!.rejected).toMatchObject({ status: 'ok', matches: [{ id: earlier.id }] });
    expect(row!.historyRetrieval!.rejected!.matches).toHaveLength(1);
  });
});
