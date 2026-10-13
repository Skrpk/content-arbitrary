import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import {
  DEFAULT_WORKSPACE_ID,
  processedPosts,
  publicationHistoryEmbeddings,
  publicationHistoryItems,
  radarCandidateEmbeddings,
  radarEvaluations,
  sources,
  storyPosts,
  syncState,
  telegramMessages,
  workspaces,
} from '@/db/schema';
import { embedPublicationHistory } from '@/lib/history/embeddings/embed';
import { RADAR_PROMPT_APPROVED } from '@/lib/radar/prompt';
import { createRadarRun } from '@/lib/radar/shadow';
import { loadReviewQueue } from '@/lib/review/queue';
import { addYouTubeSource } from '@/lib/sources/add-youtube';
import { placeInStory } from '@/lib/stories/cluster';
import { publishDecidedPost } from '@/lib/sync/publish';
import { syncPosts } from '@/lib/sync/sync-posts';
import { TelegramClient } from '@/lib/telegram/client';
import { XClient } from '@/lib/x/client';
import { YouTubeClient } from '@/lib/youtube/client';
import type { TranscriptResult, VideoTranscriptProvider } from '@/lib/youtube/transcript';
import { createTestLogger, ensureTestWorkspace, instantSleep, testDestination, withEnv } from './helpers';
import { fakeEmbedding, fakeEmbeddings } from './history-fakes';
import { fakeAnthropic, messageResponse, radarOutput } from './radar-fakes';

/**
 * YouTube channels through the whole pipeline, against a real database: the
 * YouTube Data API, Supadata, the Bot API and Radar's model are stubbed;
 * sources, claims, the review queue, Radar's prompt, embeddings and stories
 * are real.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  if (!connectionString) return;
  sql = postgres(connectionString, { max: 8, prepare: false });
  db = drizzle(sql, { schema });
});

afterAll(async () => {
  if (sql) await sql.end();
});

beforeEach(async () => {
  if (!connectionString) return;
  await db.delete(radarEvaluations);
  await db.delete(radarCandidateEmbeddings);
  await db.delete(telegramMessages);
  await db.delete(processedPosts);
  await db.delete(syncState);
  await db.delete(sources);
  await db.delete(publicationHistoryEmbeddings);
  await db.delete(publicationHistoryItems);
  await ensureTestWorkspace(db);
  channel.uploads = [];
  channel.videos.clear();
  channel.requests.length = 0;
});

const CHANNEL_ID = 'UC7_gcs09iThXybpVgjHZ_7g';
const FOLLOWED = new Date('2026-10-10T00:00:00Z');

// --- YouTube, Supadata and Telegram ---------------------------------------------------

const channel = {
  /** The uploads playlist, newest first. */
  uploads: [] as { id: string; publishedAt: string | null }[],
  videos: new Map<string, Record<string, unknown>>(),
  requests: [] as URL[],
};

function upload(id: string, publishedAt: string | null, details: { title?: string; description?: string; live?: string } = {}) {
  channel.uploads.unshift({ id, publishedAt });
  channel.videos.set(id, {
    id,
    snippet: {
      title: details.title ?? `Video ${id}`,
      description: details.description ?? `About ${id}.`,
      channelId: CHANNEL_ID,
      channelTitle: 'PBS Space Time',
      publishedAt: publishedAt ?? '2026-12-01T00:00:00Z',
      liveBroadcastContent: details.live ?? 'none',
    },
    contentDetails: { duration: 'PT15M' },
    statistics: { viewCount: '1000', likeCount: '50', commentCount: '4' },
  });
}

function youtubeClient() {
  const fetchImpl = vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    channel.requests.push(url);
    const resource = url.pathname.split('/').pop();
    if (resource === 'playlistItems') {
      expect(url.searchParams.get('playlistId')).toBe('UU7_gcs09iThXybpVgjHZ_7g');
      return Response.json({
        items: channel.uploads.map((item) => ({
          contentDetails: { videoId: item.id, ...(item.publishedAt ? { videoPublishedAt: item.publishedAt } : {}) },
        })),
      });
    }
    if (resource === 'videos') {
      return Response.json({ items: url.searchParams.get('id')!.split(',').map((id) => channel.videos.get(id)).filter(Boolean) });
    }
    if (resource === 'channels') {
      return Response.json({
        items: [{ id: CHANNEL_ID, snippet: { title: 'PBS Space Time', customUrl: '@pbsspacetime' }, contentDetails: { relatedPlaylists: { uploads: 'UU7_gcs09iThXybpVgjHZ_7g' } } }],
      });
    }
    return Response.json({}, { status: 404 });
  });
  return new YouTubeClient({ apiKey: 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch });
}

function transcripts(answer: (url: string) => TranscriptResult) {
  const asked: string[] = [];
  const provider: VideoTranscriptProvider = {
    name: 'fake',
    async getTranscript(url) {
      asked.push(url);
      return answer(url);
    },
  };
  return { provider, asked };
}

function telegram() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body;
    const body = (typeof raw === 'string' ? JSON.parse(raw) : {}) as Record<string, unknown>;
    calls.push({ method: url.split('/').pop()!, body });
    return Response.json({ ok: true, result: { message_id: calls.length + 700, chat: { id: Number(body.chat_id) } } });
  });
  const client = new TelegramClient({ token: '123456:TEST', baseUrl: 'https://api.telegram.example', fetchImpl: fetchImpl as unknown as typeof fetch, attempts: 1, sleep: instantSleep });
  return { client, calls };
}

const unusedX = () =>
  new XClient({
    bearerToken: 'fake',
    baseUrl: 'https://api.x.example',
    fetchImpl: vi.fn(async () => {
      throw new Error('X should not be called');
    }) as unknown as typeof fetch,
    attempts: 1,
  });

const approvalEnv = {
  DRY_RUN: 'false',
  REQUIRE_APPROVAL: 'true',
  TELEGRAM_ADMIN_CHAT_ID: '555001',
  TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(64),
  TELEGRAM_CHAT_ID: '-1003906212630',
  MAX_POSTS_PER_RUN: '5',
  APP_BASE_URL: 'https://radar.example',
};

async function sync(options: { transcripts?: VideoTranscriptProvider | null; radar?: ReturnType<typeof createRadarRun>; youtube?: YouTubeClient | null } = {}) {
  const bot = telegram();
  const summary = await withEnv(approvalEnv, (env) =>
    syncPosts({
      db,
      env,
      xClient: unusedX(),
      telegramClient: bot.client,
      youtubeClient: options.youtube === undefined ? youtubeClient() : options.youtube,
      transcriptProvider: options.transcripts ?? null,
      logger: createTestLogger(),
      sleep: instantSleep,
      skipLock: true,
      translationProvider: null,
      imageUnderstander: null,
      ...(options.radar ? { radarRun: options.radar } : {}),
    }),
  );
  return { summary, bot };
}

async function follow() {
  const [source] = await db
    .insert(sources)
    .values({ workspaceId: DEFAULT_WORKSPACE_ID, platform: 'youtube', externalId: CHANNEL_ID, username: 'PBS Space Time', followingSince: FOLLOWED })
    .returning();
  return source!;
}

const rows = () => db.select().from(processedPosts).orderBy(processedPosts.id);

// --- The tests -------------------------------------------------------------------------

describeIfDb('adding a YouTube channel', () => {
  it('finds it by handle and stores it by its channel id, once', async () => {
    const youtube = youtubeClient();
    const first = await addYouTubeSource(db, { channel: 'youtube.com/@pbsspacetime', workspaceId: DEFAULT_WORKSPACE_ID, youtube });
    const again = await addYouTubeSource(db, { channel: '@pbsspacetime', workspaceId: DEFAULT_WORKSPACE_ID, youtube });

    expect(first).toMatchObject({ ok: true, created: true, title: 'PBS Space Time', handle: '@pbsspacetime' });
    expect(again).toMatchObject({ ok: true, created: false });
    expect(await db.select().from(sources)).toEqual([
      expect.objectContaining({ platform: 'youtube', externalId: CHANNEL_ID, username: 'PBS Space Time' }),
    ]);
    expect(channel.requests.every((url) => url.pathname.endsWith('/channels'))).toBe(true);
  });

  it('turns a video away, and says when the key is missing', async () => {
    expect(await addYouTubeSource(db, { channel: 'https://youtu.be/abc', workspaceId: DEFAULT_WORKSPACE_ID, youtube: youtubeClient() })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('a link to a video'),
    });
    expect(await addYouTubeSource(db, { channel: '@pbsspacetime', workspaceId: DEFAULT_WORKSPACE_ID, youtube: null })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('YOUTUBE_API_KEY'),
    });
  });
});

describeIfDb('a YouTube channel in the sync', () => {
  it('follows from now: the channel’s earlier videos are not sent', async () => {
    await follow();
    upload('old1', '2026-10-01T10:00:00Z');
    upload('old2', '2026-10-05T10:00:00Z');

    const { summary, bot } = await sync();

    expect(summary.sources[0]).toMatchObject({ platform: 'youtube', checked: 2, newPosts: 0 });
    expect(await rows()).toHaveLength(0);
    expect(bot.calls).toHaveLength(0);
    expect(channel.requests.map((url) => url.pathname.split('/').pop())).toEqual(['playlistItems']);
  });

  it('queues new videos oldest first with their metadata, once, and keeps the transcript out of the post', async () => {
    await follow();
    upload('old1', '2026-10-01T10:00:00Z');
    upload('new1', '2026-10-12T10:00:00Z', { title: 'Primordial black holes', description: 'Could they be dark matter?\n\nhttps://sponsor.example' });
    upload('new2', '2026-10-13T10:00:00Z');
    upload('premiere', null, { live: 'upcoming' });
    const told = transcripts((url) =>
      url.endsWith('new1') ? { status: 'available', text: 'Today we ask whether black holes formed in the first second.', language: 'en' } : { status: 'unavailable' },
    );

    const { summary } = await sync({ transcripts: told.provider });

    expect(summary.sources[0]).toMatchObject({ newPosts: 2, awaitingApproval: 2 });
    const [first, second] = await rows();
    expect(first).toMatchObject({
      externalId: 'yt:new1',
      xPostUrl: 'https://www.youtube.com/watch?v=new1',
      xAuthorUsername: 'PBS Space Time',
      status: 'awaiting_approval',
      sourceText: 'Primordial black holes\n\nCould they be dark matter?',
      analysisText: 'Today we ask whether black holes formed in the first second.',
      sourceMetadata: expect.objectContaining({ durationSeconds: 900, views: 1000, transcript: expect.objectContaining({ status: 'available', language: 'en' }) }),
    });
    expect(first!.caption).not.toContain('Today we ask');
    expect(first!.approvalPayload).toMatchObject({ method: 'sendMessage', linkPreviewUrl: 'https://www.youtube.com/watch?v=new1' });
    expect(second).toMatchObject({ externalId: 'yt:new2', analysisText: null, sourceMetadata: expect.objectContaining({ transcript: expect.objectContaining({ status: 'unavailable' }) }) });
    // One playlist page and one batch of details.
    expect(channel.requests.map((url) => url.pathname.split('/').pop())).toEqual(['playlistItems', 'videos']);
    expect(channel.requests[1]!.searchParams.get('id')).toBe('new1,new2');

    // Next run: the same videos are known — not queued again, their transcripts not asked again.
    channel.requests.length = 0;
    const again = await sync({ transcripts: told.provider });
    expect(again.summary.sources[0]).toMatchObject({ newPosts: 0 });
    expect(await rows()).toHaveLength(2);
    expect(told.asked).toHaveLength(2);
    expect(channel.requests.map((url) => url.pathname.split('/').pop())).toEqual(['playlistItems']);
  });

  it('goes on with metadata alone when the transcript provider fails, or there is none', async () => {
    await follow();
    upload('v1', '2026-10-12T10:00:00Z');
    const failing = transcripts(() => ({ status: 'failed', error: 'Supadata did not answer' }));

    await sync({ transcripts: failing.provider });
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'awaiting_approval', analysisText: null, sourceMetadata: expect.objectContaining({ transcript: expect.objectContaining({ status: 'failed' }) }) });

    upload('v2', '2026-10-13T10:00:00Z');
    await sync({ transcripts: null });
    expect((await rows())[1]).toMatchObject({ externalId: 'yt:v2', sourceMetadata: expect.objectContaining({ transcript: { status: 'not_configured' } }) });
  });

  it('says why it cannot read the channel without a key, and reads it again once there is one', async () => {
    await follow();
    upload('v1', '2026-10-12T10:00:00Z');
    const { summary } = await sync({ youtube: null });
    expect(summary.sources[0]!.error).toContain('YOUTUBE_API_KEY');
    expect(await rows()).toHaveLength(0);

    await sync();
    expect(await rows()).toHaveLength(1);
  });

  it('shows Radar the transcript, embeds it with the video, and puts the video in a story with the post on the same event', async () => {
    await db.update(workspaces).set({ editorialProfile: 'Space news.' }).where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
    // Something to search, so the video is embedded, and an earlier post on the same event.
    await db.insert(publicationHistoryItems).values({ workspaceId: DEFAULT_WORKSPACE_ID, platform: 'telegram', publicationKey: '-100', externalId: '1', contentType: 'post', text: 'Moon rocket', publishedAt: new Date('2026-01-01') });
    const embeddings = fakeEmbeddings();
    await embedPublicationHistory({ db, embeddings: embeddings.provider, workspaceId: DEFAULT_WORKSPACE_ID });
    const [earlier] = await db
      .insert(processedPosts)
      .values({ workspaceId: DEFAULT_WORKSPACE_ID, externalId: '1799500000000000001', xPostUrl: 'https://x.com/nasa/status/1', xAuthorUsername: 'nasa', sourceText: 'Webb webb webb', status: 'awaiting_approval', createdAt: new Date(Date.now() - 3_600_000) })
      .returning();
    await db.insert(radarCandidateEmbeddings).values({ processedPostId: earlier!.id, model: 'text-embedding-3-small', dimensions: fakeEmbedding('x').length, contentFingerprint: 'f', embedding: fakeEmbedding('Webb webb webb') });
    await placeInStory(db, { workspaceId: DEFAULT_WORKSPACE_ID, processedPostId: earlier!.id, model: 'text-embedding-3-small' });
    embeddings.calls.length = 0;

    await follow();
    upload('webb', new Date().toISOString(), { title: 'A new result', description: 'Watch.' });
    const told = transcripts(() => ({ status: 'available', text: 'Webb webb webb has seen something new.', language: 'en' }));
    const radar = fakeAnthropic(() => messageResponse(radarOutput({ score: 70 })));

    await sync({
      transcripts: told.provider,
      radar: createRadarRun({ provider: radar.provider, embeddings: embeddings.provider, promptVersions: [RADAR_PROMPT_APPROVED] }),
    });

    const shown = JSON.stringify(radar.requests[0]!.messages);
    expect(shown).toContain('PBS Space Time (YouTube)');
    expect(shown).toContain('YouTube video, 15 min');
    expect(shown).toContain('<transcript>\\nWebb webb webb has seen something new.\\n</transcript>');
    expect(embeddings.calls[0]![0]).toContain('TRANSCRIPT: Webb webb webb has seen something new.');

    const video = (await rows()).find((row) => row.externalId === 'yt:webb')!;
    const placed = await db.select().from(storyPosts);
    expect(placed.find((row) => row.processedPostId === video.id)?.storyId).toBe(placed.find((row) => row.processedPostId === earlier!.id)?.storyId);
  });

  it('is in the queue under its channel, and goes out as its text and its link', async () => {
    await follow();
    upload('v1', '2026-10-12T10:00:00Z', { title: 'Primordial black holes' });
    await sync({ transcripts: transcripts(() => ({ status: 'available', text: 'SECRET TRANSCRIPT', language: 'en' })).provider });

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
    const queue = await loadReviewQueue(db, workspace!);
    expect(queue.items[0]).toMatchObject({ platform: 'youtube', sourceLabel: 'PBS Space Time', url: 'https://www.youtube.com/watch?v=v1', media: [] });

    const [row] = await rows();
    const bot = telegram();
    await withEnv(approvalEnv, (env) =>
      publishDecidedPost({ db, env, client: bot.client, row: row!, payload: row!.approvalPayload!, destination: testDestination(env), logger: createTestLogger(), reviewedAt: new Date() }),
    );
    expect(bot.calls.map((call) => call.method)).toEqual(['sendMessage']);
    expect(String(bot.calls[0]!.body.text)).toContain('Primordial black holes');
    expect(String(bot.calls[0]!.body.text)).not.toContain('SECRET TRANSCRIPT');
    expect(bot.calls[0]!.body.link_preview_options).toMatchObject({ url: 'https://www.youtube.com/watch?v=v1' });
  });
});
