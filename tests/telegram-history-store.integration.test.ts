import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import { DEFAULT_WORKSPACE_ID, processedPosts, publicationHistoryImports, publicationHistoryItems } from '@/db/schema';
import { telegramJsonAdapter } from '@/lib/history/adapters/telegram-json';
import { importPublicationHistory, storeParsedPublicationHistory } from '@/lib/history/import-history';
import { crawlChannelHistory, TELEGRAM_PUBLIC_ADAPTER } from '@/lib/onboarding/telegram-history';
import { channelPage } from './channel-page-fakes';
import { ensureTestWorkspace } from './helpers';

/**
 * A channel's history read from its page is stored as an export is: under
 * the channel's Bot API id, with an audit record, never in processed_posts —
 * and a Desktop export of the same channel later updates the same items.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(() => {
  if (!connectionString) return;
  sql = postgres(connectionString, { max: 4, prepare: false });
  db = drizzle(sql, { schema });
});

afterAll(async () => {
  if (sql) await sql.end();
});

beforeEach(async () => {
  if (!connectionString) return;
  await db.delete(publicationHistoryItems);
  await db.delete(publicationHistoryImports);
  await db.delete(processedPosts);
  await ensureTestWorkspace(db);
});

const CHANNEL_ID = 1234567890;
const BASE = Date.UTC(2026, 10, 1);

function fakeChannel(count: number) {
  return vi.fn(async (input: unknown) => {
    const before = Number(new URL(String(input)).searchParams.get('before') ?? count + 1);
    const ids = Array.from({ length: count }, (_, index) => index + 1).filter((id) => id < before).slice(-20);
    return new Response(
      channelPage(ids.map((id) => ({ id, text: `Post ${id}`, date: new Date(BASE + id * 60_000).toISOString() })), 'VECTOR', 'vector'),
    );
  }) as unknown as typeof fetch;
}

const crawlAndStore = async (count: number) => {
  const crawl = await crawlChannelHistory('vector', {
    publicationKey: `-100${CHANNEL_ID}`,
    fetchImpl: fakeChannel(count),
    sleep: async () => {},
  });
  return storeParsedPublicationHistory({
    db,
    workspaceId: DEFAULT_WORKSPACE_ID,
    source: { adapter: TELEGRAM_PUBLIC_ADAPTER, originalFilename: 't.me/s/vector', fileSha256: crawl.sha256 },
    parsed: crawl.parsed,
  });
};

describeIfDb('a channel’s history read from its page', () => {
  it('is stored with an audit record, and storing it again changes nothing', async () => {
    const first = await crawlAndStore(150);
    expect(first.counts).toMatchObject({ imported: 100, updated: 0, unchanged: 0 });

    const items = await db.select().from(publicationHistoryItems);
    expect(items).toHaveLength(100);
    expect(new Set(items.map((item) => item.publicationKey))).toEqual(new Set([`-100${CHANNEL_ID}`]));
    expect(await db.select().from(processedPosts)).toEqual([]);

    const [audit] = await db.select().from(publicationHistoryImports).where(eq(publicationHistoryImports.id, first.importId!));
    expect(audit).toMatchObject({ status: 'completed', adapter: 'telegram-public', originalFilename: 't.me/s/vector' });

    const again = await crawlAndStore(150);
    expect(again.counts).toMatchObject({ imported: 0, unchanged: 100 });
    expect(await db.select().from(publicationHistoryItems)).toHaveLength(100);
  });

  it('is updated, not duplicated, by a Desktop export of the same channel', async () => {
    await crawlAndStore(150);
    const exported = {
      name: 'VECTOR',
      type: 'public_channel',
      id: CHANNEL_ID,
      messages: [149, 150].map((id) => ({
        id,
        type: 'message',
        date: '2026-11-01T00:00:00',
        date_unixtime: String(BASE / 1000 + id * 60),
        text: `Post ${id}, as exported`,
      })),
    };
    const report = await importPublicationHistory({
      db,
      workspaceId: DEFAULT_WORKSPACE_ID,
      adapter: telegramJsonAdapter,
      file: { name: 'result.json', bytes: new TextEncoder().encode(JSON.stringify(exported)) },
    });
    expect(report.counts).toMatchObject({ imported: 0, updated: 2 });
    expect(await db.select().from(publicationHistoryItems)).toHaveLength(100);
  });

  it('leaves a failed audit record, and no items, when reading fails', async () => {
    await expect(
      storeParsedPublicationHistory({
        db,
        workspaceId: DEFAULT_WORKSPACE_ID,
        source: { adapter: TELEGRAM_PUBLIC_ADAPTER, originalFilename: 't.me/s/vector', fileSha256: 'x' },
        parsed: async () => {
          throw new Error('t.me went away');
        },
      }),
    ).rejects.toThrow('t.me went away');
    const [audit] = await db.select().from(publicationHistoryImports);
    expect(audit).toMatchObject({ status: 'failed', errorMessage: expect.stringContaining('t.me went away') });
    expect(await db.select().from(publicationHistoryItems)).toEqual([]);
  });
});
