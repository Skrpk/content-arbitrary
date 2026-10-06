import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { asc, eq } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import {
  DEFAULT_WORKSPACE_ID,
  publicationHistoryImports,
  publicationHistoryItems,
  workspaces,
} from '@/db/schema';
import { telegramJsonAdapter } from '@/lib/history/adapters/telegram-json';
import { importPublicationHistory } from '@/lib/history/import-history';
import { getPublicationHistoryStats, HISTORY_UPSERT_BATCH } from '@/lib/history/repository';
import { ensureTestWorkspace } from './helpers';

/**
 * Publication history against a real database: the identity constraint, what
 * a re-import changes, and that a failed import leaves a record and no damage.
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
  await db.delete(publicationHistoryItems);
  await db.delete(publicationHistoryImports);
  await ensureTestWorkspace(db);
});

const BASE_TIME = 1_773_842_400;

/** A Telegram Desktop export of channel `chatId` holding messages `from`..`to`. */
function exportFile(
  ids: number[],
  options: { chatId?: number; extra?: (id: number) => Record<string, unknown> } = {},
) {
  const content = {
    name: 'VECTOR',
    type: 'public_channel',
    id: options.chatId ?? 1234567890,
    messages: ids.map((id) => ({
      id,
      type: 'message',
      date: '2026-03-18T14:00:00',
      date_unixtime: String(BASE_TIME + id * 60),
      from: 'VECTOR',
      from_id: 'channel1234567890',
      text: `Post ${id}`,
      text_entities: [{ type: 'plain', text: `Post ${id}` }],
      ...options.extra?.(id),
    })),
  };
  return { name: 'result.json', bytes: new TextEncoder().encode(JSON.stringify(content)) };
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const run = (file: ReturnType<typeof exportFile>, workspaceId = DEFAULT_WORKSPACE_ID, extra = {}) =>
  importPublicationHistory({ db, workspaceId, adapter: telegramJsonAdapter, file, ...extra });

const storedItems = () =>
  db.select().from(publicationHistoryItems).orderBy(asc(publicationHistoryItems.id));

describeIfDb('publication history import', () => {
  it('stores the canonical items and a completed import record', async () => {
    const report = await run(
      exportFile([1, 2], { extra: (id) => (id === 2 ? { text: '', photo: 'photos/p2.jpg' } : {}) }),
    );

    expect(report.counts).toMatchObject({ seen: 2, imported: 2, updated: 0, unchanged: 0, skipped: 0, failed: 0 });
    expect(report.content).toEqual({ textOnly: 1, withPhoto: 1, withVideo: 0, otherMedia: 0 });

    const rows = await storedItems();
    expect(rows.map((row) => [row.platform, row.publicationKey, row.externalId, row.text])).toEqual([
      ['telegram', '-1001234567890', '1', 'Post 1'],
      ['telegram', '-1001234567890', '2', null],
    ]);
    expect(rows[1]!.media).toEqual([
      { type: 'photo', relativePath: 'photos/p2.jpg', available: true, width: null, height: null, fileSizeBytes: null },
    ]);
    expect(rows[0]!.publishedAt).toEqual(new Date((BASE_TIME + 60) * 1000));
    expect(rows.every((row) => row.importId === report.importId)).toBe(true);

    const [record] = await db.select().from(publicationHistoryImports);
    expect(record).toMatchObject({
      id: report.importId,
      workspaceId: DEFAULT_WORKSPACE_ID,
      adapter: 'telegram-json',
      platform: 'telegram',
      publicationKey: '-1001234567890',
      originalFilename: 'result.json',
      status: 'completed',
      itemsSeen: 2,
      itemsImported: 2,
      errorMessage: null,
    });
    expect(record!.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record!.completedAt).not.toBeNull();
  });

  it('importing the same export twice adds nothing and changes nothing', async () => {
    await run(exportFile(range(1, 50)));
    const before = await storedItems();

    const second = await run(exportFile(range(1, 50)));

    expect(second.counts).toMatchObject({ imported: 0, updated: 0, unchanged: 50 });
    const after = await storedItems();
    expect(after).toHaveLength(50);
    // Untouched rows keep their import and update time.
    expect(after).toEqual(before);
  });

  it('a later, longer export adds only the new messages', async () => {
    await run(exportFile(range(1, 100)));
    const second = await run(exportFile(range(1, 120)));

    expect(second.counts).toMatchObject({ seen: 120, imported: 20, updated: 0, unchanged: 100 });
    expect(await storedItems()).toHaveLength(120);
  });

  it('updates what a later export knows better, never the identity', async () => {
    const first = await run(
      exportFile([7], { extra: () => ({ text: 'Old', photo: '(File not included. Change data exporting settings to download.)' }) }),
    );
    const [original] = await storedItems();
    expect(original!.media[0]).toMatchObject({ relativePath: null, available: false });

    const second = await run(
      exportFile([7], {
        extra: () => ({ text: 'Edited', photo: 'photos/p7.jpg', edited_unixtime: String(BASE_TIME + 9999) }),
      }),
    );

    expect(second.counts).toMatchObject({ imported: 0, updated: 1, unchanged: 0 });
    const [updated] = await storedItems();
    expect(updated).toMatchObject({
      id: original!.id,
      workspaceId: DEFAULT_WORKSPACE_ID,
      platform: 'telegram',
      publicationKey: '-1001234567890',
      externalId: '7',
      text: 'Edited',
      editedAt: new Date((BASE_TIME + 9999) * 1000),
      importId: second.importId,
      createdAt: original!.createdAt,
    });
    expect(updated!.media[0]).toMatchObject({ relativePath: 'photos/p7.jpg', available: true });
    expect(second.importId).not.toBe(first.importId);
  });

  it('the same message id in two channels is two items', async () => {
    await run(exportFile([123], { chatId: 111 }));
    await run(exportFile([123], { chatId: 222 }));

    const rows = await storedItems();
    expect(rows.map((row) => row.publicationKey)).toEqual(['-100111', '-100222']);
    expect(await getPublicationHistoryStats(db, DEFAULT_WORKSPACE_ID)).toMatchObject([
      { platform: 'telegram', publicationKey: '-100111', items: 1 },
      { platform: 'telegram', publicationKey: '-100222', items: 1 },
    ]);
  });

  it('two workspaces importing the same channel are independent', async () => {
    const [other] = await db.insert(workspaces).values({ name: 'other' }).returning();

    await run(exportFile(range(1, 10)));
    const second = await run(exportFile(range(1, 10)), other!.id);

    expect(second.counts).toMatchObject({ imported: 10, unchanged: 0 });
    expect(await storedItems()).toHaveLength(20);
    expect(await getPublicationHistoryStats(db, other!.id)).toMatchObject([{ items: 10 }]);
  });

  it('the database itself refuses a duplicate identity', async () => {
    const row = {
      workspaceId: DEFAULT_WORKSPACE_ID,
      platform: 'telegram',
      publicationKey: '-100111',
      externalId: '1',
      contentType: 'post' as const,
      publishedAt: new Date(),
    };
    await db.insert(publicationHistoryItems).values(row);
    await expect(db.insert(publicationHistoryItems).values(row)).rejects.toMatchObject({
      cause: expect.objectContaining({ constraint_name: 'publication_history_items_identity_key' }),
    });
  });

  it('a malformed file fails the import record and leaves stored history alone', async () => {
    await run(exportFile(range(1, 5)));
    const before = await storedItems();

    await expect(
      run({ name: 'broken.json', bytes: new TextEncoder().encode('{"messages": [') }),
    ).rejects.toThrow(/not valid JSON/);

    expect(await storedItems()).toEqual(before);
    const records = await db
      .select()
      .from(publicationHistoryImports)
      .orderBy(asc(publicationHistoryImports.id));
    expect(records.map((record) => record.status)).toEqual(['completed', 'failed']);
    expect(records[1]).toMatchObject({ originalFilename: 'broken.json', platform: null });
    expect(records[1]!.errorMessage).toMatch(/HistoryFormatError: broken\.json is not valid JSON/);
    expect(records[1]!.completedAt).not.toBeNull();
  });

  it('an import interrupted part-way writes nothing and is recorded as failed', async () => {
    let checks = 0;
    // Lets the first batch through, then stops: the rollback must take it back.
    const signal = {
      throwIfAborted() {
        checks += 1;
        if (checks > 1) throw new Error('interrupted (Ctrl+C)');
      },
    } as unknown as AbortSignal;

    await expect(run(exportFile(range(1, HISTORY_UPSERT_BATCH + 10)), DEFAULT_WORKSPACE_ID, { signal })).rejects.toThrow(
      'interrupted',
    );

    expect(checks).toBe(2);
    expect(await storedItems()).toHaveLength(0);
    const [record] = await db.select().from(publicationHistoryImports);
    expect(record).toMatchObject({ status: 'failed', platform: 'telegram', publicationKey: '-1001234567890' });
    expect(record!.errorMessage).toContain('interrupted');
  });

  it('a dry run reports what would happen and writes nothing', async () => {
    await run(exportFile(range(1, 3)));
    const report = await run(exportFile(range(1, 5)), DEFAULT_WORKSPACE_ID, { dryRun: true });

    expect(report).toMatchObject({ importId: null, dryRun: true });
    expect(report.counts).toMatchObject({ seen: 5, imported: 2, unchanged: 3 });
    expect(await storedItems()).toHaveLength(3);
    expect(await db.select().from(publicationHistoryImports)).toHaveLength(1);
  });

  it('a message repeated within one export is stored once', async () => {
    const report = await run(exportFile([1, 1, 2]));

    expect(report.counts).toMatchObject({ seen: 3, imported: 2, skipped: 1 });
    expect(report.skippedByReason).toEqual({ duplicate_in_export: 1 });
  });

  it('history goes when its workspace does', async () => {
    const [other] = await db.insert(workspaces).values({ name: 'other' }).returning();
    await run(exportFile([1]), other!.id);

    await db.delete(workspaces).where(eq(workspaces.id, other!.id));

    expect(await storedItems()).toHaveLength(0);
    expect(await db.select().from(publicationHistoryImports)).toHaveLength(0);
  });
});
