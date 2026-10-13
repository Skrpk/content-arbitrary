import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import { DEFAULT_WORKSPACE_ID, processedPosts, radarCandidateEmbeddings, radarEvaluations, stories, storyPosts, workspaces } from '@/db/schema';
import { deleteStories, loadUnplacedPosts, placeInStory } from '@/lib/stories/cluster';
import { formatStoryReport, loadStoryReportRows } from '@/lib/stories/report';
import { loadStoryContext } from '@/lib/stories/context';
import { RADAR_PROMPT_STORY } from '@/lib/radar/prompt';
import { createRadarRun, runLiveRadar } from '@/lib/radar/shadow';
import { fakeEmbedding, fakeEmbeddings } from './history-fakes';
import { fakeAnthropic, messageResponse, radarOutput } from './radar-fakes';
import { createTestLogger, ensureTestWorkspace } from './helpers';

/**
 * Story clustering against a real database: a post joins the story of the
 * nearest post before it in the window when they are close enough, starts
 * its own otherwise, and records what it was compared with either way.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  if (!connectionString) return;
  sql = postgres(connectionString, { max: 4, prepare: false });
  db = drizzle(sql, { schema });
});

afterAll(async () => {
  if (sql) await sql.end();
});

beforeEach(async () => {
  if (!connectionString) return;
  await db.delete(stories);
  await db.delete(radarEvaluations);
  await db.delete(radarCandidateEmbeddings);
  await db.delete(processedPosts);
  await ensureTestWorkspace(db);
});

const MODEL = 'text-embedding-3-small';
const HOUR = 3_600_000;
const START = new Date('2026-10-10T08:00:00Z').getTime();

/** A unit vector at `angle` degrees from the first axis: its similarity to `angle 0` is cos(angle). */
function vectorAt(angle: number): number[] {
  const vector = new Array<number>(1536).fill(0);
  vector[0] = Math.cos((angle * Math.PI) / 180);
  vector[1] = Math.sin((angle * Math.PI) / 180);
  return vector;
}

let nextId = 1_795_000_000_000_000_000n;

async function post(input: {
  hours: number;
  angle?: number | null;
  author?: string;
  status?: 'published' | 'rejected' | 'awaiting_approval';
  rejectionReason?: 'already_covered' | 'too_minor';
  workspaceId?: number;
  /** When it was decided, in hours from the start; an hour after it arrived when decided and not given. */
  reviewedHours?: number;
  text?: string;
  vector?: number[];
}) {
  nextId += 1n;
  const [row] = await db
    .insert(processedPosts)
    .values({
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      externalId: String(nextId),
      xPostUrl: `https://x.com/${input.author ?? 'nasa'}/status/${nextId}`,
      xAuthorUsername: input.author ?? 'nasa',
      sourceText: input.text ?? `post ${nextId}`,
      status: input.status ?? 'awaiting_approval',
      rejectionReason: input.rejectionReason ?? null,
      reviewedAt:
        (input.status ?? 'awaiting_approval') === 'awaiting_approval'
          ? null
          : new Date(START + (input.reviewedHours ?? input.hours + 1) * HOUR),
      createdAt: new Date(START + input.hours * HOUR),
    })
    .returning();
  if (input.angle !== null) {
    await db.insert(radarCandidateEmbeddings).values({
      processedPostId: row!.id,
      model: MODEL,
      dimensions: (input.vector ?? vectorAt(input.angle ?? 0)).length,
      contentFingerprint: 'f',
      embedding: input.vector ?? vectorAt(input.angle ?? 0),
    });
  }
  return row!;
}

const place = (processedPostId: number, workspaceId = DEFAULT_WORKSPACE_ID) =>
  placeInStory(db, { workspaceId, processedPostId, model: MODEL });

describeIfDb('placing posts in stories', () => {
  it('starts a story with the first post, and joins a close one from another source to it', async () => {
    const first = await post({ hours: 0, author: 'SpaceX' });
    const second = await post({ hours: 2, angle: 20, author: 'NASASpaceflight' }); // cos 20° ≈ 0.94

    const a = await place(first.id);
    const b = await place(second.id);

    expect(a).toMatchObject({ outcome: 'started', nearestPostId: null, similarity: null });
    expect(b).toMatchObject({ outcome: 'joined', storyId: a!.storyId, nearestPostId: first.id });
    expect(b!.similarity).toBeCloseTo(Math.cos((20 * Math.PI) / 180), 5);
    expect(await db.select().from(stories)).toHaveLength(1);
  });

  it('starts its own story when the nearest is not close enough, and still records it', async () => {
    const first = await post({ hours: 0 });
    const other = await post({ hours: 1, angle: 50 }); // cos 50° ≈ 0.64
    const a = await place(first.id);
    const b = await place(other.id);

    expect(b).toMatchObject({ outcome: 'started', nearestPostId: first.id });
    expect(b!.storyId).not.toBe(a!.storyId);
    const [row] = await db.select().from(storyPosts).where(eq(storyPosts.processedPostId, other.id));
    expect(row).toMatchObject({ threshold: 0.75, embeddingModel: MODEL });
    expect(row!.similarity).toBeCloseTo(0.643, 3);
  });

  it('joins the story of the nearest post, so a story grows link by link', async () => {
    const posts = [await post({ hours: 0, angle: 0 }), await post({ hours: 10, angle: 30 }), await post({ hours: 20, angle: 60 })];
    const placed = [];
    for (const row of posts) placed.push(await place(row.id));

    // 60° from the first (0.5), but 30° from the second (0.87).
    expect(placed.map((placement) => placement!.outcome)).toEqual(['started', 'joined', 'joined']);
    expect(new Set(placed.map((placement) => placement!.storyId)).size).toBe(1);
    expect(placed[2]!.nearestPostId).toBe(posts[1]!.id);
  });

  it('looks back only through the window, and never at a later post or another workspace', async () => {
    await db.insert(workspaces).values({ id: 2, name: 'other' });
    const foreign = await post({ hours: 0, workspaceId: 2 });
    await place(foreign.id, 2);
    const old = await post({ hours: 0 });
    await place(old.id);

    const late = await post({ hours: 49 });
    expect(await place(late.id)).toMatchObject({ outcome: 'started', nearestPostId: null });

    const later = await post({ hours: 60 });
    const earlier = await post({ hours: 55 });
    await place(later.id);
    // Placed after it, but arrived before it: `later` is not its past.
    expect(await place(earlier.id)).toMatchObject({ outcome: 'joined', nearestPostId: late.id });
  });

  it('places a post once, and leaves out a post with no vector', async () => {
    const row = await post({ hours: 0 });
    const first = await place(row.id);
    expect(await place(row.id)).toMatchObject({ outcome: 'existing', storyId: first!.storyId });
    expect(await db.select().from(storyPosts)).toHaveLength(1);

    const bare = await post({ hours: 1, angle: null });
    expect(await place(bare.id)).toBeNull();
  });
});

describeIfDb('clustering a workspace again, and the report', () => {
  it('places the unplaced in the order they arrived, and reports what the editor did with each story', async () => {
    const launch = await post({ hours: 0, author: 'SpaceX', status: 'published' });
    const again = await post({ hours: 3, angle: 10, author: 'NASA', status: 'rejected', rejectionReason: 'already_covered' });
    const twice = await post({ hours: 5, angle: 15, author: 'ESA', status: 'published' });
    const galaxy = await post({ hours: 1, angle: 80, author: 'NASA', status: 'rejected' });
    await place(galaxy.id);

    expect(await loadUnplacedPosts(db, { workspaceId: DEFAULT_WORKSPACE_ID, model: MODEL })).toEqual([launch.id, again.id, twice.id]);
    for (const id of [launch.id, again.id, twice.id]) await place(id);

    const report = formatStoryReport(await loadStoryReportRows(db, DEFAULT_WORKSPACE_ID));
    expect(report).toContain('4 posts in 2 stories');
    expect(report).toContain('Stories of 2+ posts: 1, holding 3 posts (75%); from 2+ sources: 1; largest: 3');
    expect(report).toContain('Stories with 2+ posts published: 1');
    expect(report).toContain("'Already covered' rejections: 1; in a story with an earlier post: 1, one already published: 1");
    expect(report).toMatch(/0\.98 {2}repeat {4}@NASA/);

    await deleteStories(db, DEFAULT_WORKSPACE_ID);
    expect(await db.select().from(storyPosts)).toHaveLength(0);
    expect(await loadUnplacedPosts(db, { workspaceId: DEFAULT_WORKSPACE_ID, model: MODEL })).toHaveLength(4);
  });
});

describeIfDb('the story so far, for Radar', () => {
  it('counts the other sources before the post, with what the editor had done by the time it arrived', async () => {
    const published = await post({ hours: 0, author: 'nasa', status: 'published' });
    const rejectedLater = await post({ hours: 1, author: 'spacex', status: 'rejected', rejectionReason: 'too_minor', reviewedHours: 9 });
    const ownEarlier = await post({ hours: 2, author: 'esa' });
    const target = await post({ hours: 5, author: 'esa' });
    const after = await post({ hours: 6, author: 'latestinspace', status: 'published' });
    for (const row of [published, rejectedLater, ownEarlier, target, after]) await place(row.id);

    const context = await loadStoryContext(db, { processedPostId: target.id, before: target.createdAt });

    expect(context).toMatchObject({ earlierPosts: 3, otherSources: 2 });
    expect(context!.posts.map((entry) => [entry.processedPostId, entry.decision, entry.sameSource, entry.rejectionReason])).toEqual([
      [ownEarlier.id, 'undecided', true, null],
      // Turned down only after the post arrived: not yet known then.
      [rejectedLater.id, 'undecided', false, null],
      [published.id, 'published', false, null],
    ]);
    expect(context!.posts[2]!.hoursBefore).toBe(5);
    expect(await loadStoryContext(db, { processedPostId: (await post({ hours: 7, angle: null })).id, before: new Date() })).toBeNull();
  });

  it('places a new post live and shows its story to the story prompt, recording what it showed', async () => {
    const earlier = await post({ hours: 0, author: 'nasa', status: 'published', text: 'Webb sees a record radio burst', vector: fakeEmbedding('Webb sees a record radio burst') });
    await placeInStory(db, { workspaceId: DEFAULT_WORKSPACE_ID, processedPostId: earlier.id, model: MODEL });
    const candidate = await post({ hours: 3, author: 'esa', angle: null, text: 'Webb sees a record radio burst' });
    const { provider, requests } = fakeAnthropic(() => messageResponse(radarOutput({ score: 25 })));

    await runLiveRadar(
      createRadarRun({ provider, embeddings: fakeEmbeddings().provider, promptVersions: [RADAR_PROMPT_STORY] }),
      db,
      {
        workspaceId: DEFAULT_WORKSPACE_ID,
        processedPostId: candidate.id,
        profile: 'Space news.',
        item: { sourceUsername: 'esa', text: 'Webb sees a record radio burst', media: 'photo' },
      },
      createTestLogger(),
    );

    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]!.messages)).toContain('from 1 other source');
    expect(JSON.stringify(requests[0]!.messages)).toContain('<story_post source=\\"@nasa\\" hours_before=\\"3\\" editor=\\"published\\">');
    const [placed] = await db.select().from(storyPosts).where(eq(storyPosts.processedPostId, candidate.id));
    expect(placed).toMatchObject({ nearestPostId: earlier.id });
    const [row] = await db.select().from(radarEvaluations);
    expect(row!.historyRetrieval?.story).toEqual({
      storyId: placed!.storyId,
      earlierPosts: 1,
      otherSources: 1,
      posts: [{ id: earlier.id, decision: 'published' }],
    });
  });
});
