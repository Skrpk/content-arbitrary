import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import {
  DEFAULT_WORKSPACE_ID,
  mediaUnderstandings,
  processedPosts,
  publicationHistoryEmbeddings,
  publicationHistoryImports,
  publicationHistoryItems,
  radarCandidateEmbeddings,
  radarEvaluations,
  sources,
  syncState,
  telegramMessages,
  workspaces,
  type HistoricalMediaItem,
} from '@/db/schema';
import { embedPublicationHistory } from '@/lib/history/embeddings/embed';
import { understandHistoryImages } from '@/lib/media/history';
import { imageFingerprint } from '@/lib/media/image';
import type { ImageUnderstander } from '@/lib/media/provider';
import { understandImage } from '@/lib/media/understand';
import { MEDIA_UNDERSTANDING_PROMPT_VERSION, type MediaUnderstandingConfig } from '@/lib/media/understanding';
import {
  RADAR_PROMPT_APPROVED,
  RADAR_PROMPT_BASELINE,
  RADAR_PROMPT_MEDIA,
} from '@/lib/radar/prompt';
import { createRadarRun } from '@/lib/radar/shadow';
import { syncPosts } from '@/lib/sync/sync-posts';
import { TelegramClient } from '@/lib/telegram/client';
import { XClient } from '@/lib/x/client';
import { createTestLogger, ensureTestWorkspace, instantSleep, POSTED_AT, withEnv } from './helpers';
import { fakeEmbeddings } from './history-fakes';
import { aurora, jpeg } from './media-fakes';
import { fakeAnthropic, messageResponse, radarOutput } from './radar-fakes';

/**
 * Image understanding against a real database: looked at once, reused by
 * every Radar version and by retrieval, never in the way of review — and the
 * history backfill that reads an export's files.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

const config: MediaUnderstandingConfig = {
  model: 'gpt-6-luna',
  promptVersion: MEDIA_UNDERSTANDING_PROMPT_VERSION,
  detail: 'low',
};

beforeAll(async () => {
  if (!connectionString) return;
  sql = postgres(connectionString, { max: 6, prepare: false });
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
  await db.delete(publicationHistoryImports);
  await db.delete(mediaUnderstandings);
  await ensureTestWorkspace(db);
});

/** A vision model that answers with `aurora`, or fails when told to, counting its calls. */
function fakeUnderstander(options: { fail?: boolean } = {}) {
  const understand = vi.fn<ImageUnderstander['understand']>(async () => {
    if (options.fail) throw new Error('vision API timed out');
    return { understanding: aurora, inputTokens: 95, outputTokens: 60 };
  });
  return { model: 'gpt-6-luna', understand } satisfies ImageUnderstander;
}

describeIfDb('understanding one image', () => {
  it('looks at the same bytes once, and stores the cost of doing so', async () => {
    const understander = fakeUnderstander();

    const first = await understandImage({ db, understander, config, bytes: jpeg(1) });
    const again = await understandImage({ db, understander, config, bytes: jpeg(1) });
    const other = await understandImage({ db, understander, config, bytes: jpeg(2) });

    expect(understander.understand).toHaveBeenCalledTimes(2);
    expect(first).toMatchObject({ cached: false, understanding: aurora, fingerprint: imageFingerprint(jpeg(1)) });
    expect(again).toMatchObject({ cached: true, understanding: aurora });
    expect(again.row!.id).toBe(first.row!.id);
    expect(other.row!.id).not.toBe(first.row!.id);
    expect(first.row).toMatchObject({ status: 'ok', inputTokens: 95, outputTokens: 60, mediaType: 'image/jpeg' });
    expect(first.row!.costUsd).toBeCloseTo((95 * 0.1 + 60 * 0.5) / 1_000_000);
  });

  it('records a failure, gives nothing back, and tries again next time', async () => {
    const failed = await understandImage({ db, understander: fakeUnderstander({ fail: true }), config, bytes: jpeg(1) });
    expect(failed).toMatchObject({ understanding: null, row: { status: 'failed' } });
    expect(failed.row!.error).toContain('vision API timed out');

    const retried = await understandImage({ db, understander: fakeUnderstander(), config, bytes: jpeg(1) });
    expect(retried).toMatchObject({ cached: false, understanding: aurora, row: { id: failed.row!.id, status: 'ok' } });
  });

  it('is a new look under another model or prompt version, and the old one is kept', async () => {
    const understander = fakeUnderstander();
    await understandImage({ db, understander, config, bytes: jpeg(1) });
    await understandImage({ db, understander, config: { ...config, promptVersion: 'img-v2' }, bytes: jpeg(1) });

    expect(understander.understand).toHaveBeenCalledTimes(2);
    expect(await db.select().from(mediaUnderstandings)).toHaveLength(2);
  });

  it('sends nothing that is not a supported image', async () => {
    const understander = fakeUnderstander();
    const result = await understandImage({ db, understander, config, bytes: new TextEncoder().encode('GIF89a') });

    expect(result).toMatchObject({ understanding: null, fingerprint: null });
    expect(understander.understand).not.toHaveBeenCalled();
  });
});

describeIfDb('a new post with a photo, in the sync', () => {
  const approvalEnv = {
    DRY_RUN: 'false',
    REQUIRE_APPROVAL: 'true',
    TELEGRAM_ADMIN_CHAT_ID: '555001',
    TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(64),
    TELEGRAM_CHAT_ID: '-1003906212630',
  };

  /** X answers with one post of `photos` photos; their files are distinct JPEG bytes. */
  function stacks(photos = 1) {
    const keys = Array.from({ length: photos }, (_, index) => `3_${index}`);
    const xClient = new XClient({
      bearerToken: 'fake',
      baseUrl: 'https://api.x.example',
      fetchImpl: vi.fn(async () =>
        Response.json({
          data: [
            {
              id: '1760000000000099001',
              text: 'Це просто неймовірно',
              created_at: POSTED_AT,
              author_id: '999',
              attachments: { media_keys: keys },
            },
          ],
          includes: {
            users: [{ id: '999', username: 'esa' }],
            media: keys.map((key) => ({
              media_key: key,
              type: 'photo',
              url: `https://cdn.example/${key}.jpg`,
              width: 1600,
              height: 1200,
            })),
          },
          meta: { result_count: 1, newest_id: '1760000000000099001' },
        }),
      ) as unknown as typeof fetch,
      attempts: 1,
    });

    const fetchImpl = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (!url.includes('api.telegram.example')) {
        const index = Number(/3_(\d+)/.exec(url)?.[1] ?? 0);
        return new Response(jpeg(10 + index), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      const method = url.split('/').pop()!;
      return Response.json({
        ok: true,
        result:
          method === 'sendMessage'
            ? { message_id: 31, chat: { id: 555001 } }
            : method === 'sendMediaGroup'
              ? keys.map((_, index) => ({ message_id: 40 + index, chat: { id: 555001 }, photo: [{ file_id: `F${index}`, file_size: 9 }] }))
              : { message_id: 30, chat: { id: 555001 }, photo: [{ file_id: 'ONE', file_size: 900 }] },
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

  async function sync(options: { photos?: number; understander?: ReturnType<typeof fakeUnderstander> } = {}) {
    await db.insert(sources).values({ workspaceId: DEFAULT_WORKSPACE_ID, platform: 'x', externalId: '999', username: 'esa' });
    await db.update(workspaces).set({ editorialProfile: 'Space.' }).where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
    // Something to search, so retrieval embeds the candidate.
    await db.insert(publicationHistoryItems).values({
      workspaceId: DEFAULT_WORKSPACE_ID,
      platform: 'telegram',
      publicationKey: '-100',
      externalId: '1',
      contentType: 'post',
      text: 'Полярне сяйво з МКС',
      publishedAt: new Date('2026-01-01'),
    });
    const embeddings = fakeEmbeddings();
    await embedPublicationHistory({ db, embeddings: embeddings.provider, workspaceId: DEFAULT_WORKSPACE_ID });
    embeddings.calls.length = 0;

    const radar = fakeAnthropic(() => messageResponse(radarOutput({ score: 70 })));
    const understander = options.understander ?? fakeUnderstander();
    const { xClient, telegramClient, fetchImpl } = stacks(options.photos);

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
        translationProvider: null,
        imageUnderstander: understander,
        radarRun: createRadarRun({
          provider: radar.provider,
          embeddings: embeddings.provider,
          promptVersions: [RADAR_PROMPT_BASELINE, RADAR_PROMPT_APPROVED, RADAR_PROMPT_MEDIA],
          mediaConfig: config,
        }),
      }),
    );
    return { radar, understander, embeddings };
  }

  it('is looked at once, and every Radar version reads that — none is sent the image', async () => {
    const { radar, understander } = await sync();

    expect(understander.understand).toHaveBeenCalledTimes(1);
    expect(radar.requests).toHaveLength(3);
    expect(JSON.stringify(radar.requests)).not.toContain('"type":"image"');

    const media = radar.requests.find((request) => JSON.stringify(request.system).includes('Image descriptions'))!;
    expect(JSON.stringify(media.messages)).toContain("View from the ISS of a green aurora over Earth's night side");

    const [post] = await db.select().from(processedPosts);
    expect(post!.status).toBe('awaiting_approval');
    expect(post!.imageFingerprint).toBe(imageFingerprint(jpeg(10)));

    const [understanding] = await db.select().from(mediaUnderstandings);
    const rows = await db.select().from(radarEvaluations).orderBy(asc(radarEvaluations.promptVersion));
    expect(rows.map((row) => [row.promptVersion, row.variant, row.mediaUnderstandingId])).toEqual([
      [RADAR_PROMPT_BASELINE, 'text', null],
      [RADAR_PROMPT_APPROVED, 'text', null],
      [RADAR_PROMPT_MEDIA, 'text', understanding!.id],
    ]);
  });

  it('embeds the candidate with what its image shows, for retrieval', async () => {
    const { embeddings } = await sync();

    expect(embeddings.calls).toHaveLength(1);
    expect(embeddings.calls[0]![0]).toContain('Це просто неймовірно\n\nIMAGE: View from the ISS');
  });

  it('looks only at the first photo of an album', async () => {
    const { understander } = await sync({ photos: 5 });

    expect(understander.understand).toHaveBeenCalledTimes(1);
    const image = understander.understand.mock.calls[0]![0];
    expect(imageFingerprint(image.bytes)).toBe(imageFingerprint(jpeg(10)));
  });

  it('sends the post to review and scores it all the same when the image cannot be understood', async () => {
    const { radar } = await sync({ understander: fakeUnderstander({ fail: true }) });

    const [post] = await db.select().from(processedPosts);
    expect(post!.status).toBe('awaiting_approval');
    expect(radar.requests).toHaveLength(3);
    const rows = await db.select().from(radarEvaluations);
    expect(rows.every((row) => row.status === 'ok' && row.mediaUnderstandingId === null)).toBe(true);
    expect(await db.select().from(mediaUnderstandings)).toEqual([expect.objectContaining({ status: 'failed' })]);
  });
});

describeIfDb('the history’s images', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'export-'));
    await mkdir(join(root, 'photos'));
    await writeFile(join(root, 'photos', 'a.jpg'), jpeg(1));
    await writeFile(join(root, 'photos', 'b.jpg'), jpeg(2));
    await writeFile(join(tmpdir(), 'outside.jpg'), jpeg(3));
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  const photo = (relativePath: string, available = true): HistoricalMediaItem => ({ type: 'photo', relativePath, available });

  async function item(externalId: string, text: string | null, media: HistoricalMediaItem[]) {
    const [row] = await db
      .insert(publicationHistoryItems)
      .values({
        workspaceId: DEFAULT_WORKSPACE_ID,
        platform: 'telegram',
        publicationKey: '-100',
        externalId,
        contentType: 'post',
        text,
        media,
        publishedAt: new Date(`2026-01-0${externalId}`),
      })
      .returning();
    return row!;
  }

  async function seed() {
    return {
      withText: await item('1', 'Полярне сяйво', [photo('photos/a.jpg')]),
      imageOnly: await item('2', null, [photo('photos/b.jpg')]),
      leftOut: await item('3', 'Не експортовано', [photo('photos/c.jpg', false)]),
      missing: await item('4', 'Файлу немає', [photo('photos/gone.jpg')]),
      climbing: await item('5', 'Шлях назовні', [photo('../outside.jpg')]),
      textOnly: await item('6', 'Лише текст', []),
    };
  }

  const run = (understander: ImageUnderstander | null, extra: { limit?: number; dryRun?: boolean; mediaRoot?: string } = {}) =>
    understandHistoryImages({ db, understander, config, workspaceId: DEFAULT_WORKSPACE_ID, mediaRoot: root, ...extra });

  it('counts first in a dry run, then understands only what is there, once', async () => {
    await seed();
    const understander = fakeUnderstander();

    expect(await run(understander, { dryRun: true })).toMatchObject({
      imageItems: 5,
      unavailable: 3,
      alreadyUnderstood: 0,
      toUnderstand: 2,
    });
    expect(understander.understand).not.toHaveBeenCalled();

    expect(await run(understander)).toMatchObject({ toUnderstand: 2, understood: 2, failed: 0, unavailable: 3 });
    expect(understander.understand).toHaveBeenCalledTimes(2);

    // Resumable: everything understood is passed over.
    expect(await run(understander)).toMatchObject({ alreadyUnderstood: 2, toUnderstand: 0 });
    expect(understander.understand).toHaveBeenCalledTimes(2);
  });

  it('stops at --limit and picks up the rest next run', async () => {
    await seed();
    const understander = fakeUnderstander();

    expect(await run(understander, { limit: 1 })).toMatchObject({ understood: 1, overLimit: 1 });
    expect(await run(understander, { limit: 1 })).toMatchObject({ alreadyUnderstood: 1, understood: 1, overLimit: 0 });
  });

  it('refuses a media root that is not there', async () => {
    await expect(run(fakeUnderstander(), { mediaRoot: join(root, 'nope') })).rejects.toThrow(/not a directory/);
  });

  it('re-embeds only the items whose image was understood, and gives an image-only one its first vector', async () => {
    const items = await seed();
    const embeddings = fakeEmbeddings();
    const embed = () =>
      embedPublicationHistory({ db, embeddings: embeddings.provider, workspaceId: DEFAULT_WORKSPACE_ID, mediaConfig: config });

    expect(await embed()).toMatchObject({ embedded: 5, skippedNoText: 1 });
    expect(await db.select().from(publicationHistoryEmbeddings).where(eq(publicationHistoryEmbeddings.publicationHistoryItemId, items.imageOnly.id))).toHaveLength(0);

    await run(fakeUnderstander());
    embeddings.calls.length = 0;

    expect(await embed()).toMatchObject({ embedded: 1, reembedded: 1, alreadyEmbedded: 4, skippedNoText: 0 });
    const sent = embeddings.calls.flat();
    expect(sent).toHaveLength(2);
    expect(sent.some((text) => text.startsWith('Полярне сяйво\n\nIMAGE:'))).toBe(true);
    expect(sent.some((text) => text.startsWith('IMAGE:'))).toBe(true);
  });
});
