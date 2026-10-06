import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { asc } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import {
  DEFAULT_WORKSPACE_ID,
  processedPosts,
  publicationHistoryImports,
  publicationHistoryItems,
  publicationHistoryProfiles,
  radarEvaluations,
  workspaces,
} from '@/db/schema';
import { buildPublicationProfile } from '@/lib/history/profile/build';
import { PUBLICATION_PROFILE_PROMPT_VERSION } from '@/lib/history/profile/prompt';
import { insertPublicationProfile } from '@/lib/history/profile/repository';
import { RadarError } from '@/lib/radar/output';
import { ingestRadarBatch, submitRadarBackfill, waitForBatch } from '@/lib/radar/backfill';
import { createRadarRun, runLiveRadar } from '@/lib/radar/shadow';
import { RADAR_PROMPT_BASELINE } from '@/lib/radar/prompt';
import { createTestLogger, ensureTestWorkspace } from './helpers';
import { fakeProfiler, profileFixture } from './history-fakes';
import { fakeAnthropic, fakeBatchProvider, messageResponse, radarOutput } from './radar-fakes';

const BASELINE_ONLY = [RADAR_PROMPT_BASELINE] as const;

/**
 * From publication history to a stored profile, and from the profile into
 * Shadow Radar — live, and in a backfill that must not see the future.
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
  await db.delete(processedPosts);
  await db.delete(publicationHistoryProfiles);
  await db.delete(publicationHistoryItems);
  await db.delete(publicationHistoryImports);
  await ensureTestWorkspace(db);
});

const day = (n: number) => new Date(Date.UTC(2026, 7, 1 + n, 10));

/** `count` past posts of a channel, one a day from 1 August, each about 300 characters. */
async function seedHistory(count: number, options: { workspaceId?: number; prefix?: string; from?: number } = {}) {
  const from = options.from ?? 1;
  const rows = await db
    .insert(publicationHistoryItems)
    .values(
      Array.from({ length: count }, (_, i) => ({
        workspaceId: options.workspaceId ?? DEFAULT_WORKSPACE_ID,
        platform: 'telegram',
        publicationKey: '-100111',
        externalId: String(from + i),
        contentType: 'post' as const,
        text: `${options.prefix ?? 'Post'} ${from + i}: ${'космос '.repeat(40)}`,
        publishedAt: day(from + i),
        media: [{ type: 'photo' as const, relativePath: null, available: false }],
      })),
    )
    .returning();
  return rows;
}

const build = (provider: ReturnType<typeof fakeProfiler>['provider'], extra = {}) =>
  buildPublicationProfile({ db, provider, workspaceId: DEFAULT_WORKSPACE_ID, batchChars: 1200, ...extra });

const storedProfiles = () => db.select().from(publicationHistoryProfiles).orderBy(asc(publicationHistoryProfiles.id));

describeIfDb('building a publication profile', () => {
  it('distils history into a stored profile, in bounded batches, from this workspace only', async () => {
    const items = await seedHistory(12);
    // A photo with no caption is history too, though it gives no text.
    await db.insert(publicationHistoryItems).values({
      workspaceId: DEFAULT_WORKSPACE_ID,
      platform: 'telegram',
      publicationKey: '-100111',
      externalId: '99',
      contentType: 'post',
      text: null,
      publishedAt: day(20),
      media: [{ type: 'photo', relativePath: 'photos/a.jpg', available: true }],
    });
    // Neither text nor media: nothing the channel said, so not counted.
    await db.insert(publicationHistoryItems).values({
      workspaceId: DEFAULT_WORKSPACE_ID,
      platform: 'telegram',
      publicationKey: '-100111',
      externalId: '100',
      contentType: 'post',
      text: null,
      publishedAt: day(25),
      media: [],
    });
    const [other] = await db.insert(workspaces).values({ name: 'other' }).returning();
    await seedHistory(3, { workspaceId: other!.id, prefix: 'OTHER TENANT' });

    const profiler = fakeProfiler();
    const result = await build(profiler.provider);

    const notes = profiler.calls.filter((call) => call.kind === 'notes');
    expect(notes.length).toBeGreaterThanOrEqual(4);
    expect(profiler.calls.at(-1)!.kind).toBe('profile');
    for (const call of notes) expect(call.input.length).toBeLessThan(1300);
    expect(profiler.calls.some((call) => call.input.includes('OTHER TENANT'))).toBe(false);
    // Oldest first, each post once.
    const shown = notes.flatMap((call) => [...call.input.matchAll(/<item id="(\d+)"/g)].map((m) => Number(m[1])));
    expect(shown).toEqual(items.map((item) => item.id));

    expect(result).toMatchObject({
      status: 'created',
      model: 'gpt-6-luna',
      promptVersion: PUBLICATION_PROFILE_PROMPT_VERSION,
      historyCutoffAt: day(20),
    });
    expect(result.facts).toMatchObject({ items: 13, textItems: 12, mediaOnlyItems: 1 });

    const [row] = await storedProfiles();
    expect(row).toMatchObject({
      id: result.profileId,
      workspaceId: DEFAULT_WORKSPACE_ID,
      sourceItemCount: 13,
      sourceFingerprint: result.sourceFingerprint,
      historyCutoffAt: day(20),
      model: 'gpt-6-luna',
      promptVersion: PUBLICATION_PROFILE_PROMPT_VERSION,
    });
    expect(row!.inputTokens).toBe(result.usage.inputTokens);
    expect(row!.inputTokens).toBeGreaterThan(0);

    // The model's nominations, minus the id that is not in the history.
    const representatives = (row!.profile as { representativeItemIds: number[] }).representativeItemIds;
    expect(representatives.length).toBeGreaterThan(0);
    expect(representatives).not.toContain(999_999);
    expect(representatives.every((id) => items.some((item) => item.id === id))).toBe(true);
  });

  it('merges notes that are too many for one request before writing the profile', async () => {
    await seedHistory(30);
    const profiler = fakeProfiler();
    await build(profiler.provider);

    expect(profiler.calls.some((call) => call.kind === 'merge')).toBe(true);
    expect(profiler.calls.filter((call) => call.kind === 'profile')).toHaveLength(1);
  });

  it('does not profile the same history twice, unless forced', async () => {
    await seedHistory(5);
    const profiler = fakeProfiler();
    const first = await build(profiler.provider);
    const callsAfterFirst = profiler.calls.length;

    const again = await build(profiler.provider);
    expect(again).toMatchObject({ status: 'up_to_date', profileId: first.profileId, calls: 0 });
    expect(again.profile).toEqual(first.profile);
    expect(profiler.calls).toHaveLength(callsAfterFirst);
    expect(await storedProfiles()).toHaveLength(1);

    const forced = await build(profiler.provider, { force: true });
    expect(forced.status).toBe('created');
    expect(profiler.calls.length).toBeGreaterThan(callsAfterFirst);
    expect(await storedProfiles()).toHaveLength(2);
  });

  it('profiles again once history changes, and says the old one is stale', async () => {
    await seedHistory(5);
    const profiler = fakeProfiler();
    const first = await build(profiler.provider);
    await seedHistory(2, { from: 6 });

    const second = await build(profiler.provider);

    expect(second.status).toBe('created');
    expect(second.sourceFingerprint).not.toBe(first.sourceFingerprint);
    expect(second.stale).toEqual({ profileId: first.profileId, sourceItemCount: 5 });
    expect(second.historyCutoffAt).toEqual(day(7));
  });

  it('stores nothing on a dry run', async () => {
    await seedHistory(5);
    const result = await build(fakeProfiler().provider, { dryRun: true });

    expect(result).toMatchObject({ status: 'dry_run', profileId: null });
    expect(result.profile.summary).toContain('space');
    expect(await storedProfiles()).toHaveLength(0);
  });

  it('refuses a malformed profile, storing nothing', async () => {
    await seedHistory(5);
    const profiler = fakeProfiler({ profile: () => ({ summary: 'only this' }) });

    await expect(build(profiler.provider)).rejects.toBeInstanceOf(RadarError);
    expect(await storedProfiles()).toHaveLength(0);
  });

  it('says what to do when there is no history', async () => {
    await expect(build(fakeProfiler().provider)).rejects.toThrow(/npm run history:import/);
  });
});

// ---------------------------------------------------------------------------
// Radar
// ---------------------------------------------------------------------------

let nextPostId = 1_770_000_000_000_000_000n;

async function decidedPost(input: {
  decision: 'approve' | 'reject' | 'pending';
  createdAt: Date;
  reviewedAt?: Date;
  text?: string;
}) {
  nextPostId += 1n;
  const [row] = await db
    .insert(processedPosts)
    .values({
      workspaceId: DEFAULT_WORKSPACE_ID,
      xPostId: String(nextPostId),
      xPostUrl: `https://x.com/esa/status/${nextPostId}`,
      xAuthorUsername: 'esa',
      sourceText: input.text ?? `post ${nextPostId}`,
      status: input.decision === 'approve' ? 'published' : input.decision === 'reject' ? 'rejected' : 'awaiting_approval',
      telegramMethod: 'sendPhoto',
      mediaCount: 1,
      reviewedAt: input.decision === 'pending' ? null : (input.reviewedAt ?? input.createdAt),
      rejectionReason: input.decision === 'reject' ? 'too_minor' : null,
      createdAt: input.createdAt,
    })
    .returning();
  return row!;
}

async function storeProfile(historyCutoffAt: Date, summary = 'A Ukrainian channel about space.') {
  return insertPublicationProfile(db, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    profile: profileFixture({ summary }),
    sourceItemCount: 10,
    sourceFingerprint: 'f'.repeat(64),
    historyCutoffAt,
    model: 'gpt-6-luna',
    promptVersion: PUBLICATION_PROFILE_PROMPT_VERSION,
  });
}

const subject = (processedPostId: number) => ({
  workspaceId: DEFAULT_WORKSPACE_ID,
  processedPostId,
  profile: 'Space and sci-fi.',
  item: { sourceUsername: 'esa', text: 'A new nebula image', media: 'photo' },
});

describeIfDb('live Radar with a publication profile', () => {
  it('carries the newest profile beside the policy and the decisions, and records which', async () => {
    await storeProfile(day(10), 'An older profile.');
    const newest = await storeProfile(day(20), 'A Ukrainian channel about space.');
    await decidedPost({ decision: 'reject', createdAt: day(30), text: 'A rejected example' });
    const post = await decidedPost({ decision: 'pending', createdAt: day(40) });
    const { provider, requests } = fakeAnthropic(() => messageResponse(radarOutput()));

    await runLiveRadar(createRadarRun({ promptVersions: BASELINE_ONLY, provider }), db, subject(post.id), createTestLogger());

    const system = requests[0]!.system as string;
    expect(system).toContain('<editorial_profile>\nSpace and sci-fi.\n</editorial_profile>');
    expect(system).toContain('<publication_history>\nSummary: A Ukrainian channel about space.');
    expect(system).not.toContain('An older profile.');
    expect(system.indexOf('<editorial_profile>')).toBeLessThan(system.indexOf('<publication_history>'));
    expect(JSON.stringify(requests[0]!.messages)).toContain('A rejected example');

    const [row] = await db.select().from(radarEvaluations);
    expect(row).toMatchObject({ status: 'ok', publicationHistoryProfileId: newest.id, promptVersion: 'radar-v1' });
  });

  it('works as before without one', async () => {
    const post = await decidedPost({ decision: 'pending', createdAt: day(40) });
    const { provider, requests } = fakeAnthropic(() => messageResponse(radarOutput({ score: 64 })));

    await runLiveRadar(createRadarRun({ promptVersions: BASELINE_ONLY, provider }), db, subject(post.id), createTestLogger());

    expect(requests[0]!.system as string).not.toContain('publication_history');
    const [row] = await db.select().from(radarEvaluations);
    expect(row).toMatchObject({ status: 'ok', score: 64, publicationHistoryProfileId: null });
  });

  it('scores without a stored profile that no longer reads as one', async () => {
    const [broken] = await db
      .insert(publicationHistoryProfiles)
      .values({
        workspaceId: DEFAULT_WORKSPACE_ID,
        profile: { summary: 'not a whole profile' },
        sourceItemCount: 1,
        sourceFingerprint: 'x',
        historyCutoffAt: day(1),
        model: 'gpt-6-luna',
        promptVersion: 'history-profile-v0',
      })
      .returning();
    const post = await decidedPost({ decision: 'pending', createdAt: day(40) });
    const { provider, requests } = fakeAnthropic(() => messageResponse(radarOutput()));
    const logger = createTestLogger();

    await runLiveRadar(createRadarRun({ promptVersions: BASELINE_ONLY, provider }), db, subject(post.id), logger);

    expect(requests[0]!.system as string).not.toContain('publication_history');
    expect((await db.select().from(radarEvaluations))[0]).toMatchObject({ status: 'ok', publicationHistoryProfileId: null });
    expect(logger.entries).toContainEqual({ event: 'radar.history_profile_invalid', data: { profileId: broken!.id } });
  });
});

describeIfDb('backfill and the publication profile', () => {
  async function backfill() {
    // Decisions behind the candidate, so it is scored at all.
    await decidedPost({ decision: 'approve', createdAt: new Date('2026-09-01T00:00:00Z') });
    await decidedPost({ decision: 'reject', createdAt: new Date('2026-09-02T00:00:00Z') });
    const candidate = await decidedPost({
      decision: 'reject',
      createdAt: new Date('2026-10-01T10:00:00Z'),
      reviewedAt: new Date('2026-10-01T12:00:00Z'),
      text: 'The candidate',
    });

    const fake = fakeBatchProvider('openai', () => ({ output: radarOutput() }));
    const submitted = await submitRadarBackfill({
      promptVersions: BASELINE_ONLY,
      db,
      provider: fake.provider,
      workspaceId: DEFAULT_WORKSPACE_ID,
      profile: 'Space.',
      minPerClass: 1,
      logger: createTestLogger(),
    });
    for (const batchId of submitted.batchIds) {
      await waitForBatch(fake.provider, batchId, { pollMs: 0, sleep: async () => {} });
      await ingestRadarBatch({ db, provider: fake.provider, batchId, workspaceId: DEFAULT_WORKSPACE_ID, logger: createTestLogger() });
    }

    const request = fake.submitted.flat().find((entry) => entry.json.includes('The candidate'))!;
    const [row] = (await db.select().from(radarEvaluations)).filter((r) => r.processedPostId === candidate.id);
    return { request, row: row! };
  }

  it('leaves out a profile made from posts published after the candidate arrived', async () => {
    await storeProfile(new Date('2026-10-05T00:00:00Z'));

    const { request, row } = await backfill();

    expect(request.json).not.toContain('publication_history');
    expect(request.customId).toMatch(/^p\d+-text$/);
    expect(row).toMatchObject({ status: 'ok', publicationHistoryProfileId: null });
  });

  it('uses a profile made only from posts published before it', async () => {
    const profile = await storeProfile(new Date('2026-09-20T00:00:00Z'));

    const { request, row } = await backfill();

    expect(request.json).toContain('publication_history');
    expect(request.customId).toBe(`p${row.processedPostId}-text-h${profile.id}`);
    expect(row).toMatchObject({ status: 'ok', publicationHistoryProfileId: profile.id });
  });
});
