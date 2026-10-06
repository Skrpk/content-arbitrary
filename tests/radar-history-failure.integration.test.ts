import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import { DEFAULT_WORKSPACE_ID, processedPosts, radarEvaluations } from '@/db/schema';
import { createRadarRun, runLiveRadar } from '@/lib/radar/shadow';
import { createTestLogger, ensureTestWorkspace } from './helpers';
import { fakeAnthropic, messageResponse, radarOutput } from './radar-fakes';

// The profile store is down: every read of it fails.
vi.mock('@/lib/history/profile/repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/history/profile/repository')>()),
  loadRadarPublicationProfile: vi.fn(async () => {
    throw new Error('connection terminated unexpectedly');
  }),
}));

/** A failure to read the publication profile costs Radar its context, not its score. */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  if (!connectionString) return;
  sql = postgres(connectionString, { max: 5, prepare: false });
  db = drizzle(sql, { schema });
});

afterAll(async () => {
  if (sql) await sql.end();
});

beforeEach(async () => {
  if (!connectionString) return;
  await db.delete(radarEvaluations);
  await db.delete(processedPosts);
  await ensureTestWorkspace(db);
});

describeIfDb('live Radar when the publication profile cannot be read', () => {
  it('scores without it, records no profile, and says why', async () => {
    const [post] = await db
      .insert(processedPosts)
      .values({
        workspaceId: DEFAULT_WORKSPACE_ID,
        xPostId: '1780000000000000001',
        xPostUrl: 'https://x.com/esa/status/1780000000000000001',
        xAuthorUsername: 'esa',
        sourceText: 'A new nebula image',
        status: 'awaiting_approval',
      })
      .returning();
    const { provider, requests } = fakeAnthropic(() => messageResponse(radarOutput({ score: 70 })));
    const logger = createTestLogger();

    await runLiveRadar(
      createRadarRun({ provider }),
      db,
      {
        workspaceId: DEFAULT_WORKSPACE_ID,
        processedPostId: post!.id,
        profile: 'Space.',
        item: { sourceUsername: 'esa', text: 'A new nebula image', media: 'photo' },
      },
      logger,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]!.system as string).not.toContain('publication_history');
    const [row] = await db.select().from(radarEvaluations);
    expect(row).toMatchObject({ status: 'ok', score: 70, publicationHistoryProfileId: null });
    expect(logger.entries.map((entry) => entry.event)).toContain('radar.history_profile_unavailable');
  });
});
