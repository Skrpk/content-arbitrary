import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import {
  DEFAULT_WORKSPACE_ID,
  processedPosts,
  radarEvaluations,
  sources,
  syncState,
  telegramMessages,
  workspaces,
} from '@/db/schema';
import { ingestRadarBatch, submitRadarBackfill, waitForBatch } from '@/lib/radar/backfill';
import { loadRadarHistory } from '@/lib/radar/repository';
import { RADAR_PROMPT_BASELINE } from '@/lib/radar/prompt';

/** These tests are about one prompt; both side by side are tested in radar-retrieval. */
const BASELINE_ONLY = [RADAR_PROMPT_BASELINE] as const;
import { formatRadarReport, loadReportRows } from '@/lib/radar/report';
import { createRadarRun, runLiveRadar, type RadarSubject } from '@/lib/radar/shadow';
import { markAwaitingApproval, rejectWithReason } from '@/lib/sync/repository';
import { syncPosts } from '@/lib/sync/sync-posts';
import { TelegramClient } from '@/lib/telegram/client';
import { XClient } from '@/lib/x/client';
import { createTestLogger, ensureTestWorkspace, instantSleep, withEnv } from './helpers';
import { fakeAnthropic, fakeBatchProvider, messageResponse, radarOutput } from './radar-fakes';

/**
 * Shadow Radar against a real database: what it may see, what it records, and
 * that nothing it does — or fails to do — changes what happens to the post.
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
  await db.delete(telegramMessages);
  await db.delete(processedPosts);
  await db.delete(syncState);
  await db.delete(sources);
  await ensureTestWorkspace(db);
});

let nextPostId = 1_760_000_000_000_000_000n;

/** A post the editor has (or has not yet) decided on. */
async function decidedPost(input: {
  decision: 'approve' | 'reject' | 'schedule' | 'pending';
  reviewedAt?: Date;
  createdAt?: Date;
  text?: string;
  workspaceId?: number;
  reviewMedia?: schema.ReviewMediaItem[];
}) {
  nextPostId += 1n;
  const status =
    input.decision === 'approve'
      ? 'published'
      : input.decision === 'reject'
        ? 'rejected'
        : input.decision === 'schedule'
          ? 'scheduled'
          : 'awaiting_approval';

  const [row] = await db
    .insert(processedPosts)
    .values({
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      xPostId: String(nextPostId),
      xPostUrl: `https://x.com/esa/status/${nextPostId}`,
      xAuthorUsername: 'esa',
      sourceText: input.text ?? `post ${nextPostId}`,
      status,
      telegramMethod: 'sendPhoto',
      mediaCount: 1,
      reviewedAt: input.decision === 'pending' ? null : (input.reviewedAt ?? new Date('2026-10-01T10:00:00Z')),
      rejectionReason: input.decision === 'reject' ? 'too_minor' : null,
      createdAt: input.createdAt ?? new Date('2026-10-01T09:00:00Z'),
      // As in production: the payload is gone once the post is decided.
      approvalPayload: null,
      reviewMedia: input.reviewMedia ?? null,
    })
    .returning();
  return row!;
}

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 10, minutes));

function subject(processedPostId: number, overrides: Partial<RadarSubject> = {}): RadarSubject {
  return {
    workspaceId: DEFAULT_WORKSPACE_ID,
    processedPostId,
    profile: 'Space and sci-fi.',
    item: { sourceUsername: 'esa', text: 'A new nebula image', media: 'photo' },
    ...overrides,
  };
}

const evaluations = () => db.select().from(radarEvaluations).orderBy(radarEvaluations.variant);

describeIfDb('loadRadarHistory', () => {
  it('shows only decisions made before the cutoff, never the post itself', async () => {
    const before = await decidedPost({ decision: 'approve', reviewedAt: at(1), text: 'Decided before' });
    await decidedPost({ decision: 'reject', reviewedAt: at(30), text: 'Decided after' });
    await decidedPost({ decision: 'pending', text: 'Undecided' });
    const current = await decidedPost({ decision: 'reject', reviewedAt: at(2), text: 'The post itself' });

    const history = await loadRadarHistory(db, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      before: at(10),
      excludePostId: current.id,
      perClass: 10,
    });

    expect(history.examples.map((example) => example.text)).toEqual(['Decided before']);
    expect(history.decisions).toBe(1);
    expect(history.approvalRate).toBe(1);
    expect(history.examples.map((example) => example.postId)).toContain(before.id);
  });

  it('counts a scheduled post as an approval, and keeps to its own tenant', async () => {
    const [other] = await db.insert(workspaces).values({ name: 'other' }).returning();
    await decidedPost({ decision: 'schedule', reviewedAt: at(1), text: 'Scheduled' });
    await decidedPost({ decision: 'reject', reviewedAt: at(2), text: 'Rejected' });
    await decidedPost({ decision: 'approve', reviewedAt: at(3), text: 'Another tenant', workspaceId: other!.id });

    const history = await loadRadarHistory(db, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      before: at(10),
      perClass: 10,
    });

    expect(history.examples.map((example) => [example.text, example.decision])).toEqual([
      ['Scheduled', 'approve'],
      ['Rejected', 'reject'],
    ]);
    expect(history.examples[1]!.rejectionReason).toBe('too_minor');
    expect(history.approvalRate).toBe(0.5);
  });

  it('takes the most recent decisions of each class, up to the limit', async () => {
    for (let minute = 1; minute <= 4; minute += 1) {
      await decidedPost({ decision: 'approve', reviewedAt: at(minute), text: `approved ${minute}` });
    }
    await decidedPost({ decision: 'reject', reviewedAt: at(5), text: 'rejected' });

    const history = await loadRadarHistory(db, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      before: at(10),
      perClass: 2,
    });

    expect(history.examples.map((example) => example.text)).toEqual(['approved 4', 'approved 3', 'rejected']);
    // The rate is over every decision, not just the examples shown.
    expect(history.decisions).toBe(5);
    expect(history.approvalRate).toBe(0.8);
  });
});

describeIfDb('runLiveRadar', () => {
  it('scores the text and the text with its image, and records both', async () => {
    const example = await decidedPost({ decision: 'approve', reviewedAt: at(1) });
    const post = await decidedPost({ decision: 'pending' });
    const { provider, requests } = fakeAnthropic(() => messageResponse(radarOutput({ score: 77 })));

    await runLiveRadar(
      createRadarRun({ promptVersions: BASELINE_ONLY, provider }),
      db,
      subject(post.id, { image: { kind: 'url', url: 'https://pbs.twimg.com/media/a.jpg' } }),
      createTestLogger(),
    );

    const rows = await evaluations();
    expect(rows.map((row) => [row.variant, row.status, row.score, row.imageIncluded])).toEqual([
      ['text', 'ok', 77, false],
      ['text_image', 'ok', 77, true],
    ]);
    expect(rows[0]).toMatchObject({
      mode: 'live',
      model: 'claude-haiku-4-5',
      promptVersion: RADAR_PROMPT_BASELINE,
      examplePostIds: [example.id],
      inputTokens: 1200,
      outputTokens: 90,
    });

    const sentImages = requests.map((request) =>
      JSON.stringify(request.messages).includes('"type":"image"'),
    );
    expect(sentImages.sort()).toEqual([false, true]);
  });

  it('scores only the text when the post has no image', async () => {
    const post = await decidedPost({ decision: 'pending' });
    const { provider, requests } = fakeAnthropic(() => messageResponse(radarOutput()));

    await runLiveRadar(createRadarRun({ promptVersions: BASELINE_ONLY, provider }), db, subject(post.id), createTestLogger());

    expect(requests).toHaveLength(1);
    expect((await evaluations()).map((row) => row.variant)).toEqual(['text']);
  });

  it('never scores the same post twice under the same setup', async () => {
    const post = await decidedPost({ decision: 'pending' });
    const { provider, requests } = fakeAnthropic(() => messageResponse(radarOutput()));
    const run = createRadarRun({ promptVersions: BASELINE_ONLY, provider });

    await runLiveRadar(run, db, subject(post.id), createTestLogger());
    await runLiveRadar(run, db, subject(post.id), createTestLogger());

    expect(requests).toHaveLength(1);
    expect(await evaluations()).toHaveLength(1);
  });

  it('records a failure without throwing', async () => {
    const post = await decidedPost({ decision: 'pending' });
    const { provider } = fakeAnthropic(
      () => new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'boom' } }), { status: 500 }),
    );

    await expect(
      runLiveRadar(createRadarRun({ promptVersions: BASELINE_ONLY, provider }), db, subject(post.id), createTestLogger()),
    ).resolves.toBeUndefined();

    const [row] = await evaluations();
    expect(row).toMatchObject({ status: 'failed', score: null });
    expect(row!.error).toBeTruthy();
  });

  it('stops calling the API once the run budget is spent, and says so', async () => {
    const post = await decidedPost({ decision: 'pending' });
    const { provider, requests } = fakeAnthropic(() => messageResponse(radarOutput()));

    await runLiveRadar(createRadarRun({ promptVersions: BASELINE_ONLY, provider, budgetMs: 0 }), db, subject(post.id), createTestLogger());

    expect(requests).toHaveLength(0);
    expect(await evaluations()).toMatchObject([{ status: 'skipped', error: 'run budget exhausted' }]);
  });

  it('stops for the rest of the run after repeated failures', async () => {
    const { provider, requests } = fakeAnthropic(() => new Response('{}', { status: 500 }));
    const run = createRadarRun({ promptVersions: BASELINE_ONLY, provider });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const post = await decidedPost({ decision: 'pending' });
      await runLiveRadar(run, db, subject(post.id), createTestLogger());
    }

    // Three calls, each retried once, then no more.
    expect(requests).toHaveLength(6);
    const statuses = (await db.select().from(radarEvaluations)).map((row) => row.status);
    expect(statuses.filter((status) => status === 'failed')).toHaveLength(3);
    expect(statuses.filter((status) => status === 'skipped')).toHaveLength(2);
  });
});

describeIfDb('Radar in the sync', () => {
  const approvalEnv = {
    DRY_RUN: 'false',
    REQUIRE_APPROVAL: 'true',
    TELEGRAM_ADMIN_CHAT_ID: '555001',
    TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(64),
    TELEGRAM_CHAT_ID: '-1003906212630',
  };

  function stack(order: string[]) {
    const xClient = new XClient({
      bearerToken: 'fake',
      baseUrl: 'https://api.x.example',
      fetchImpl: vi.fn(async () =>
        Response.json({
          data: [
            {
              id: '1760000000000099001',
              text: 'A rare photo of Saturn',
              created_at: '2026-10-01T12:00:00.000Z',
              author_id: '999',
              attachments: { media_keys: ['3_a'] },
            },
          ],
          includes: {
            users: [{ id: '999', username: 'esa' }],
            media: [{ media_key: '3_a', type: 'photo', url: 'https://cdn.example/a.jpg', width: 1600, height: 1200 }],
          },
          meta: { result_count: 1, newest_id: '1760000000000099001' },
        }),
      ) as unknown as typeof fetch,
      attempts: 1,
    });

    const fetchImpl = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (!url.includes('api.telegram.example')) {
        return new Response(new Uint8Array(256), {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': '256' },
        });
      }
      const method = url.split('/').pop()!;
      order.push(`telegram:${method}`);
      return Response.json({
        ok: true,
        result:
          method === 'sendPhoto'
            ? { message_id: 30, chat: { id: 555001 }, photo: [{ file_id: 'ONE', file_size: 900 }] }
            : { message_id: 31, chat: { id: 555001 } },
      });
    });

    const telegramClient = new TelegramClient({
      token: '123456:TEST',
      baseUrl: 'https://api.telegram.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      attempts: 1,
      sleep: instantSleep,
    });

    return { xClient, telegramClient, fetchImpl: fetchImpl as unknown as typeof fetch };
  }

  async function seed(profile: string | null) {
    await db
      .insert(sources)
      .values({ workspaceId: DEFAULT_WORKSPACE_ID, platform: 'x', externalId: '999', username: 'esa' });
    await db
      .update(workspaces)
      .set({ editorialProfile: profile })
      .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
  }

  async function sync(order: string[], respond: () => Response) {
    const { xClient, telegramClient, fetchImpl } = stack(order);
    const radar = fakeAnthropic(() => {
      order.push('radar');
      return respond();
    });

    await withEnv(approvalEnv, (env) =>
      syncPosts({
        db,
        env,
        xClient,
        telegramClient,
        fetchImpl,
        logger: createTestLogger(),
        sleep: instantSleep,
        skipLock: true,
        radarRun: createRadarRun({ promptVersions: BASELINE_ONLY, provider: radar.provider }),
      }),
    );

    return radar;
  }

  it('scores the post before it is sent for review, and changes nothing about it', async () => {
    await seed('Space and sci-fi.');
    const order: string[] = [];

    await sync(order, () => messageResponse(radarOutput({ score: 91 })));

    // Both variants, then the review send.
    expect(order.slice(0, 2)).toEqual(['radar', 'radar']);
    expect(order).toContain('telegram:sendPhoto');

    const [post] = await db.select().from(processedPosts);
    expect(post!.status).toBe('awaiting_approval');
    // What the reviewer was shown, kept for later backfills.
    expect(post!.reviewMedia).toEqual([{ kind: 'photo', fileId: 'ONE', url: 'https://cdn.example/a.jpg' }]);

    const rows = await evaluations();
    expect(rows.map((row) => [row.variant, row.score])).toEqual([
      ['text', 91],
      ['text_image', 91],
    ]);
    expect(rows.every((row) => row.processedPostId === post!.id)).toBe(true);
  });

  it('sends the post for review exactly the same when Radar fails', async () => {
    await seed('Space and sci-fi.');
    const order: string[] = [];

    await sync(order, () => new Response('{}', { status: 500 }));

    const [post] = await db.select().from(processedPosts);
    expect(post!.status).toBe('awaiting_approval');
    expect((await evaluations()).every((row) => row.status === 'failed')).toBe(true);
  });

  it('leaves a tenant without an editorial profile alone', async () => {
    await seed(null);
    const order: string[] = [];

    const radar = await sync(order, () => messageResponse(radarOutput()));

    expect(radar.requests).toHaveLength(0);
    expect(await evaluations()).toHaveLength(0);
    const [post] = await db.select().from(processedPosts);
    expect(post!.status).toBe('awaiting_approval');
  });
});

describe.each(['openai', 'anthropic'] as const)('Radar backfill through the %s batch API', (providerName) => {
  const describeBatches = connectionString ? describe : describe.skip;

  describeBatches('', () => {
    const noSleep = { pollMs: 0, sleep: async () => {} };
    const model = providerName === 'openai' ? 'gpt-6-luna' : 'claude-haiku-4-5';

    /** Two decisions before minute 10, so a post arriving then has history behind it. */
    async function history() {
      await decidedPost({ decision: 'approve', reviewedAt: at(1), createdAt: at(0) });
      await decidedPost({ decision: 'reject', reviewedAt: at(2), createdAt: at(0) });
    }

    async function submitAndIngest(
      fake: ReturnType<typeof fakeBatchProvider>,
      extra: Partial<Parameters<typeof submitRadarBackfill>[0]> = {},
    ) {
      const submitted = await submitRadarBackfill({
        promptVersions: BASELINE_ONLY,
        db,
        provider: fake.provider,
        workspaceId: DEFAULT_WORKSPACE_ID,
        profile: 'Space.',
        minPerClass: 1,
        logger: createTestLogger(),
        ...extra,
      });
      const ingested = [];
      for (const batchId of submitted.batchIds) {
        await waitForBatch(fake.provider, batchId, noSleep);
        ingested.push(
          await ingestRadarBatch({
            db,
            provider: fake.provider,
            batchId,
            workspaceId: DEFAULT_WORKSPACE_ID,
            logger: createTestLogger(),
          }),
        );
      }
      return { submitted, ingested };
    }

    it('builds each request from only the decisions made before the post arrived', async () => {
      await history();
      await decidedPost({ decision: 'approve', reviewedAt: at(20), createdAt: at(15), text: 'Later one' });
      const post = await decidedPost({ decision: 'reject', reviewedAt: at(12), createdAt: at(10), text: 'The one' });

      const fake = fakeBatchProvider(providerName, () => ({ output: radarOutput({ score: 33 }) }));
      const { submitted, ingested } = await submitAndIngest(fake);

      const request = fake.submitted[0]!.find((entry) => entry.customId === `p${post.id}-text`)!;
      expect(request.json).toContain(`"model":"${model}"`);
      expect(request.json).toContain('The one');
      expect(request.json).not.toContain('Later one');

      // The first two arrived with no history behind them.
      expect(submitted.notEnoughHistory).toBe(2);
      expect(ingested).toEqual([{ scored: 2, failed: 0 }]);

      const row = (await evaluations()).find((evaluation) => evaluation.processedPostId === post.id)!;
      expect(row).toMatchObject({ mode: 'backfill', status: 'ok', score: 33, inputTokens: 1000, model });
      expect(row.examplePostIds).toHaveLength(2);
    });

    it('never asks for or overwrites a score it already has', async () => {
      await history();
      await decidedPost({ decision: 'reject', reviewedAt: at(12), createdAt: at(10) });
      let reads = 0;
      const fake = fakeBatchProvider(providerName, () => ({
        output: radarOutput({ score: (reads += 1) === 1 ? 40 : 99 }),
      }));

      const first = await submitAndIngest(fake);
      const second = await submitAndIngest(fake);
      expect(second.submitted).toMatchObject({ posts: 0, requests: 0, batchIds: [], alreadyScored: 1 });

      // Reading the same batch again changes nothing.
      await ingestRadarBatch({
        db,
        provider: fake.provider,
        batchId: first.submitted.batchIds[0]!,
        workspaceId: DEFAULT_WORKSPACE_ID,
        logger: createTestLogger(),
      });
      expect(await evaluations()).toMatchObject([{ score: 40 }]);
    });

    it('records a failed request, and retries it on the next submit', async () => {
      await history();
      const post = await decidedPost({ decision: 'reject', reviewedAt: at(12), createdAt: at(10) });

      let attempt = 0;
      const fake = fakeBatchProvider(providerName, () =>
        (attempt += 1) === 1
          ? { error: 'busy' }
          : { output: radarOutput({ score: 12, predicted_decision: 'reject', predicted_rejection_reason: 'too_minor' }) },
      );

      const first = await submitAndIngest(fake);
      expect(first.ingested).toEqual([{ scored: 0, failed: 1 }]);
      const [failed] = await evaluations();
      expect(failed).toMatchObject({ status: 'failed' });
      expect(failed!.error).toContain('busy');

      const second = await submitAndIngest(fake);
      expect(second.submitted.requests).toBe(1);
      expect(await evaluations()).toMatchObject([
        { processedPostId: post.id, status: 'ok', score: 12, error: null },
      ]);
    });

    it('records a cut-off answer as failed, with its tokens', async () => {
      await history();
      await decidedPost({ decision: 'reject', reviewedAt: at(12), createdAt: at(10) });
      const fake = fakeBatchProvider(providerName, () => ({ output: radarOutput(), cutOff: true }));

      await submitAndIngest(fake);

      expect(await evaluations()).toMatchObject([{ status: 'failed', inputTokens: 1000 }]);
    });

    it('sends the photo the reviewer got, fetched from Telegram', async () => {
      await history();
      await decidedPost({
        decision: 'approve',
        reviewedAt: at(12),
        createdAt: at(10),
        reviewMedia: [{ kind: 'photo', fileId: 'PHOTO_1', url: 'https://pbs.twimg.com/media/p1.jpg' }],
      });

      const telegramFetch = vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith('/getFile')) return Response.json({ ok: true, result: { file_path: 'photos/file_1.jpg' } });
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      });
      const telegram = new TelegramClient({
        token: '123456:TEST',
        baseUrl: 'https://api.telegram.example',
        fetchImpl: telegramFetch as unknown as typeof fetch,
        attempts: 1,
        sleep: instantSleep,
      });
      const fake = fakeBatchProvider(providerName, () => ({ output: radarOutput() }));

      await submitAndIngest(fake, { telegram });

      expect(telegramFetch).toHaveBeenCalledWith(
        'https://api.telegram.example/file/bot123456:TEST/photos/file_1.jpg',
        expect.anything(),
      );
      const withImage = fake.submitted[0]!.find((entry) => entry.customId.endsWith('-text_image'))!;
      // [1, 2, 3] in base64.
      expect(withImage.json).toContain('AQID');
      expect((await evaluations()).map((row) => [row.variant, row.imageIncluded])).toEqual([
        ['text', false],
        ['text_image', true],
      ]);
    });

    it('counts the limit in posts it scores, not in posts it passes over', async () => {
      // The oldest posts have no history behind them and are passed over.
      await history();
      const scorable = [];
      for (let minute = 10; minute < 14; minute += 1) {
        scorable.push(await decidedPost({ decision: 'reject', reviewedAt: at(minute + 30), createdAt: at(minute) }));
      }
      const fake = fakeBatchProvider(providerName, () => ({ output: radarOutput() }));

      const { submitted } = await submitAndIngest(fake, { limit: 2 });

      expect(submitted).toMatchObject({ notEnoughHistory: 2, posts: 2, requests: 2 });
      expect((await evaluations()).map((row) => row.processedPostId).sort()).toEqual(
        scorable.slice(0, 2).map((post) => post.id).sort(),
      );
    });

    it("shows a video's still from X, and a photo from X when Telegram has lost it", async () => {
      await history();
      await decidedPost({
        decision: 'approve',
        reviewedAt: at(12),
        createdAt: at(10),
        text: 'Video post',
        reviewMedia: [{ kind: 'video', fileId: 'VIDEO_1', previewUrl: 'https://pbs.twimg.com/thumb/v1.jpg' }],
      });
      await decidedPost({
        decision: 'reject',
        reviewedAt: at(13),
        createdAt: at(11),
        text: 'Photo post',
        reviewMedia: [{ kind: 'photo', fileId: 'GONE', url: 'https://pbs.twimg.com/media/p2.jpg' }],
      });
      const telegram = new TelegramClient({
        token: '123456:TEST',
        baseUrl: 'https://api.telegram.example',
        fetchImpl: vi.fn(async () =>
          Response.json({ ok: false, error_code: 400, description: 'Bad Request: file not found' }, { status: 400 }),
        ) as unknown as typeof fetch,
        attempts: 1,
        sleep: instantSleep,
      });
      const fake = fakeBatchProvider(providerName, () => ({ output: radarOutput() }));

      await submitAndIngest(fake, { telegram });

      const imageRequests = fake.submitted[0]!.filter((entry) => entry.customId.endsWith('-text_image'));
      expect(imageRequests).toHaveLength(2);
      expect(imageRequests.some((entry) => entry.json.includes('https://pbs.twimg.com/thumb/v1.jpg'))).toBe(true);
      expect(imageRequests.some((entry) => entry.json.includes('https://pbs.twimg.com/media/p2.jpg'))).toBe(true);
    });

    it('leaves the image out with --text-only', async () => {
      await history();
      await decidedPost({
        decision: 'approve',
        reviewedAt: at(12),
        createdAt: at(10),
        reviewMedia: [{ kind: 'photo', url: 'https://pbs.twimg.com/media/p3.jpg' }],
      });
      const fake = fakeBatchProvider(providerName, () => ({ output: radarOutput() }));

      await submitAndIngest(fake, { textOnly: true });

      expect(fake.submitted[0]!.map((entry) => entry.customId.endsWith('-text'))).toEqual([true]);
    });

    it('still has the picture of a post decided through the real review flow', async () => {
      await history();
      // Queued for review the way the sync does it, then rejected by the reviewer.
      const post = await decidedPost({ decision: 'pending', createdAt: at(10) });
      await markAwaitingApproval(db, {
        id: post.id,
        payload: { method: 'sendPhoto', caption: 'c', items: [{ kind: 'photo', fileId: 'F1' }] },
        adminChatId: '555001',
        adminMessageId: 1,
        reviewMedia: [{ kind: 'photo', fileId: 'F1', url: 'https://pbs.twimg.com/media/f1.jpg' }],
      });
      await rejectWithReason(db, { id: post.id, workspaceId: DEFAULT_WORKSPACE_ID, reason: 'too_minor' });

      const [decided] = await db.select().from(processedPosts).where(eq(processedPosts.id, post.id));
      expect(decided!.approvalPayload).toBeNull();
      expect(decided!.reviewMedia).toEqual([{ kind: 'photo', fileId: 'F1', url: 'https://pbs.twimg.com/media/f1.jpg' }]);

      const fake = fakeBatchProvider(providerName, () => ({ output: radarOutput() }));
      await submitAndIngest(fake);

      expect(fake.submitted[0]!.map((entry) => entry.customId)).toEqual([`p${post.id}-text`, `p${post.id}-text_image`]);
    });

    it('splits a large backfill into several batches', async () => {
      await history();
      for (let minute = 10; minute < 13; minute += 1) {
        await decidedPost({ decision: 'reject', reviewedAt: at(minute + 30), createdAt: at(minute) });
      }
      const fake = fakeBatchProvider(providerName, () => ({ output: radarOutput() }));

      const { submitted } = await submitAndIngest(fake, { maxBatchBytes: 1 });

      expect(submitted.batchIds).toHaveLength(3);
      expect(fake.submitted.map((requests) => requests.length)).toEqual([1, 1, 1]);
      expect(await evaluations()).toHaveLength(3);
    });

    it('waits until the batch has finished', async () => {
      await history();
      await decidedPost({ decision: 'reject', reviewedAt: at(12), createdAt: at(10) });
      const fake = fakeBatchProvider(providerName, () => ({ output: radarOutput() }));
      const { batchIds } = await submitRadarBackfill({
        promptVersions: BASELINE_ONLY,
        db,
        provider: fake.provider,
        workspaceId: DEFAULT_WORKSPACE_ID,
        profile: 'Space.',
        minPerClass: 1,
        logger: createTestLogger(),
      });

      const statuses: string[] = [];
      await waitForBatch(fake.provider, batchIds[0]!, { ...noSleep, onStatus: (status) => statuses.push(status) });

      expect(statuses).toHaveLength(2);
      expect(statuses[0]).toMatch(/^in_progress/);
      expect(statuses[1]).toMatch(/^(ended|completed)/);
    });
  });
});

describeIfDb('Radar report', () => {
  it('measures backfill scores against the decisions, and counts live ones only if made first', async () => {
    const approvedHigh = await decidedPost({ decision: 'approve', reviewedAt: at(30) });
    const rejectedLow = await decidedPost({ decision: 'reject', reviewedAt: at(30) });
    const scoredLate = await decidedPost({ decision: 'approve', reviewedAt: at(1) });

    const base = { workspaceId: DEFAULT_WORKSPACE_ID, model: 'claude-haiku-4-5', promptVersion: 'radar-v0', status: 'ok' as const };
    await db.insert(radarEvaluations).values([
      { ...base, processedPostId: approvedHigh.id, mode: 'backfill', variant: 'text', score: 85, predictedDecision: 'approve', inputTokens: 1_000_000, outputTokens: 0 },
      { ...base, processedPostId: rejectedLow.id, mode: 'backfill', variant: 'text', score: 20, predictedDecision: 'reject' },
      { ...base, processedPostId: approvedHigh.id, mode: 'live', variant: 'text', score: 85, predictedDecision: 'approve', createdAt: at(5) },
      // Scored after the editor had already decided: not a prediction.
      { ...base, processedPostId: scoredLate.id, mode: 'live', variant: 'text', score: 90, predictedDecision: 'approve', createdAt: at(5) },
    ]);

    const report = formatRadarReport(await loadReportRows(db, DEFAULT_WORKSPACE_ID));

    const sections = report.split(/\n+(?===)/);
    const backfill = sections.find((section) => section.startsWith('== backfill · text'))!;
    expect(backfill).toContain('Editor approved: 1 of 2 (50%)');
    expect(backfill).toContain('Separation (AUC): 1.00');
    expect(backfill).toContain('Tokens: 1000000 in, 0 out ≈ $0.50 (batch price)');

    const live = sections.find((section) => section.startsWith('== live · text'))!;
    expect(live).toContain('Decided and counted: 1');
  });
});
