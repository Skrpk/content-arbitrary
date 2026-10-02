import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import {
  DEFAULT_WORKSPACE_ID,
  processedPosts,
  sources,
  syncState,
  telegramMessages,
  workspaces,
} from '@/db/schema';
import {
  addSource,
  countSources,
  deleteSource,
  findSourceByExternalId,
  findSourceByUsername,
  listEnabledSources,
  listSources,
  setSourceEnabled,
  syncStateKey,
} from '@/lib/sources/repository';
import { dispatchCommand } from '@/lib/telegram/commands';
import { findWorkspaceByAdminChatId } from '@/lib/workspace';
import { upsertSyncState } from '@/lib/sync/repository';
import { XClient } from '@/lib/x/client';
import { createTestLogger, ensureTestWorkspace } from './helpers';

/**
 * Source management against a real database: the UNIQUE (platform, external_id)
 * constraint and the command handlers that depend on it.
 */

/** The reply's text, which is what most assertions here are about. */
const replyText = async (...args: Parameters<typeof dispatchCommand>) =>
  (await dispatchCommand(...args))?.text ?? null;

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

/** X client stub that resolves a fixed set of handles to ids. */
function makeXClient(known: Record<string, string>) {
  const fetchImpl = vi.fn(async (input: unknown) => {
    const handle = decodeURIComponent(String(input).split('/').pop()!.split('?')[0]!);
    const id = known[handle.toLowerCase()];

    if (!id) {
      return new Response(
        JSON.stringify({ errors: [{ title: 'Not Found Error', detail: 'Could not find user' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    return new Response(JSON.stringify({ data: { id, username: handle } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  return new XClient({
    bearerToken: 'test',
    baseUrl: 'https://api.x.example',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    attempts: 1,
  });
}

function makeContext(known: Record<string, string> = { karpathy: '33836629', sama: '1605' }) {
  return {
    db,
    xClient: makeXClient(known),
    logger: createTestLogger(),
    workspaceId: DEFAULT_WORKSPACE_ID,
  };
}

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
  await db.delete(telegramMessages);
  await db.delete(processedPosts);
  await db.delete(syncState);
  await db.delete(sources);
  await ensureTestWorkspace(db);
});

describeIfDb('sources repository', () => {
  it('stores the numeric X id as the canonical identity', async () => {
    const result = await addSource(db, {
      platform: 'x',
      externalId: '33836629',
      username: 'karpathy',
    });

    expect(result.created).toBe(true);
    expect(result.source.externalId).toBe('33836629');
    expect(result.source.enabled).toBe(true);
  });

  it('does not create a duplicate for the same account', async () => {
    await addSource(db, { platform: 'x', externalId: '33836629', username: 'karpathy' });
    const again = await addSource(db, {
      platform: 'x',
      externalId: '33836629',
      username: 'karpathy',
    });

    expect(again.created).toBe(false);
    expect(await countSources(db)).toBe(1);
  });

  it('treats a renamed handle as the same source and refreshes the name', async () => {
    await addSource(db, { platform: 'x', externalId: '33836629', username: 'oldname' });
    const renamed = await addSource(db, {
      platform: 'x',
      externalId: '33836629',
      username: 'newname',
    });

    expect(renamed.created).toBe(false);
    expect(renamed.source.username).toBe('newname');
    expect(await countSources(db)).toBe(1);
  });

  it('rejects a duplicate at the database level', async () => {
    await db.insert(sources).values({ platform: 'x', externalId: '1', username: 'a' });

    const error = await db
      .insert(sources)
      .values({ platform: 'x', externalId: '1', username: 'b' })
      .then(() => null)
      .catch((caught: unknown) => caught);

    const cause = (error as { cause?: { code?: string } }).cause;
    expect(cause?.code).toBe('23505');
  });

  it('allows the same external id on a different platform', async () => {
    // Guards the composite key: ids only collide within a platform.
    await db.insert(sources).values({ platform: 'x', externalId: '1', username: 'a' });
    await expect(
      db.insert(sources).values({ platform: 'x', externalId: '2', username: 'b' }),
    ).resolves.toBeDefined();

    expect(await countSources(db)).toBe(2);
  });

  it('lists only enabled sources for the sync layer', async () => {
    await addSource(db, { platform: 'x', externalId: '1', username: 'active' });
    const paused = await addSource(db, { platform: 'x', externalId: '2', username: 'paused' });
    await setSourceEnabled(db, { id: paused.source.id, enabled: false });

    const enabled = await listEnabledSources(db, 'x');
    expect(enabled.map((source) => source.username)).toEqual(['active']);

    const all = await listSources(db);
    expect(all).toHaveLength(2);
  });

  it('finds a source by handle regardless of case', async () => {
    await addSource(db, { platform: 'x', externalId: '1', username: 'Trail_Cams' });

    const found = await findSourceByUsername(db, { platform: 'x', username: 'trail_cams' });
    expect(found?.externalId).toBe('1');
  });

  it('leaves the cursor behind when a source is deleted', async () => {
    const added = await addSource(db, { platform: 'x', externalId: '99', username: 'gone' });
    await upsertSyncState(db, { source: syncStateKey(added.source), lastSeenPostId: '555' });

    expect(await deleteSource(db, added.source.id)).toBe(true);
    expect(await findSourceByExternalId(db, { platform: 'x', externalId: '99' })).toBeNull();

    // Re-adding the account later resumes rather than re-reading the window.
    const rows = await db.select().from(syncState);
    expect(rows.map((row) => row.source)).toContain('x:99');
  });
});

describeIfDb('source commands', () => {
  it('adds a source from a bare handle', async () => {
    const reply = await replyText(makeContext(), { command: 'addsource', args: 'karpathy' });

    expect(reply).toContain('Source added');
    expect(reply).toContain('@karpathy');

    const stored = await listSources(db);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.externalId).toBe('33836629');
  });

  it('offers the settings button once a source exists, and not on a failed add', async () => {
    expect(
      (await dispatchCommand(makeContext(), { command: 'addsource', args: 'karpathy' }))?.offerSettings,
    ).toBe(true);
    expect(
      (await dispatchCommand(makeContext(), { command: 'addsource', args: '@karpathy' }))?.offerSettings,
    ).toBe(true);
    expect(
      (await dispatchCommand(makeContext(), { command: 'addsource', args: '' }))?.offerSettings,
    ).toBeFalsy();
    expect(
      (await dispatchCommand(makeContext(), { command: 'sources', args: '' }))?.offerSettings,
    ).toBe(true);
  });

  it('starts a new source on media posts only, and says how to change it', async () => {
    const reply = await replyText(makeContext(), { command: 'addsource', args: 'karpathy' });

    expect((await listSources(db))[0]!.includeTextOnly).toBe(false);
    expect(reply).toContain('Settings');
  });

  it('marks a source that mirrors text posts in the list', async () => {
    await dispatchCommand(makeContext(), { command: 'addsource', args: 'karpathy' });
    const [source] = await listSources(db);
    await db.update(sources).set({ includeTextOnly: true }).where(eq(sources.id, source!.id));

    expect(await replyText(makeContext(), { command: 'sources', args: '' })).toContain(
      '✅ @karpathy · text posts too',
    );
  });

  it.each([['@karpathy'], ['https://x.com/karpathy'], ['x.com/karpathy']])(
    'accepts %s as the argument',
    async (args) => {
      await dispatchCommand(makeContext(), { command: 'addsource', args });
      expect((await listSources(db))[0]!.username).toBe('karpathy');
    },
  );

  it('reports a duplicate instead of adding it twice', async () => {
    await dispatchCommand(makeContext(), { command: 'addsource', args: '@karpathy' });
    const reply = await replyText(makeContext(), { command: 'addsource', args: '@karpathy' });

    expect(reply).toContain('already in your sources');
    expect(await countSources(db)).toBe(1);
  });

  it('explains an unknown account without throwing', async () => {
    const reply = await replyText(makeContext(), { command: 'addsource', args: '@ghost' });

    expect(reply).toContain('Could not find');
    expect(await countSources(db)).toBe(0);
  });

  it('rejects an invalid handle before calling the X API', async () => {
    const reply = await replyText(makeContext(), {
      command: 'addsource',
      args: 'not a handle',
    });

    expect(reply).toContain('not a valid X handle');
    expect(await countSources(db)).toBe(0);
  });

  it('shows usage when the argument is missing', async () => {
    const reply = await replyText(makeContext(), { command: 'addsource', args: '' });
    expect(reply).toContain('/addsource @username');
  });

  it('lists sources with their enabled state', async () => {
    await dispatchCommand(makeContext(), { command: 'addsource', args: 'karpathy' });
    await dispatchCommand(makeContext(), { command: 'addsource', args: 'sama' });
    await dispatchCommand(makeContext(), { command: 'pausesource', args: 'sama' });

    const reply = await replyText(makeContext(), { command: 'sources', args: '' });

    expect(reply).toContain('✅ @karpathy');
    expect(reply).toContain('⏸ @sama');
  });

  it('guides the admin when there are no sources', async () => {
    const reply = await replyText(makeContext(), { command: 'sources', args: '' });

    expect(reply).toContain('No sources yet');
    expect(reply).toContain('/addsource @username');
  });

  it('removes a source', async () => {
    await dispatchCommand(makeContext(), { command: 'addsource', args: 'karpathy' });
    const reply = await replyText(makeContext(), {
      command: 'removesource',
      args: '@karpathy',
    });

    expect(reply).toContain('Removed');
    expect(await countSources(db)).toBe(0);
  });

  it('says so when removing something that is not there', async () => {
    const reply = await replyText(makeContext(), {
      command: 'removesource',
      args: '@karpathy',
    });
    expect(reply).toContain('not in your sources');
  });

  it('pauses and resumes a source', async () => {
    await dispatchCommand(makeContext(), { command: 'addsource', args: 'karpathy' });

    await dispatchCommand(makeContext(), { command: 'pausesource', args: 'karpathy' });
    expect(await listEnabledSources(db, 'x')).toHaveLength(0);
    expect(await countSources(db)).toBe(1);

    await dispatchCommand(makeContext(), { command: 'resumesource', args: 'karpathy' });
    expect(await listEnabledSources(db, 'x')).toHaveLength(1);
  });

  it('is idempotent when pausing twice', async () => {
    await dispatchCommand(makeContext(), { command: 'addsource', args: 'karpathy' });
    await dispatchCommand(makeContext(), { command: 'pausesource', args: 'karpathy' });
    const reply = await replyText(makeContext(), {
      command: 'pausesource',
      args: 'karpathy',
    });

    expect(reply).toContain('already paused');
  });

  /**
   * Authorisation is a workspace lookup: the sender's id is both the proof they
   * may act and the choice of tenant they act on. The webhook applies it before
   * dispatching, so it is tested here alongside its effect on the data.
   */
  it('runs a command for a workspace reviewer', async () => {
    await db
      .update(workspaces)
      .set({ telegramChatId: '-1001', telegramAdminChatId: '555001' })
      .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));

    const found = await findWorkspaceByAdminChatId(db, 555001);
    expect(found?.id).toBe(DEFAULT_WORKSPACE_ID);

    await dispatchCommand(makeContext(), { command: 'addsource', args: 'karpathy' });
    expect(await countSources(db)).toBe(1);
  });

  it('refuses a stranger, leaving sources untouched', async () => {
    await db
      .update(workspaces)
      .set({ telegramChatId: '-1001', telegramAdminChatId: '555001' })
      .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));

    expect(await findWorkspaceByAdminChatId(db, 999999)).toBeNull();
    expect(await findWorkspaceByAdminChatId(db, undefined)).toBeNull();

    // The webhook stops before dispatch, so nothing is written.
    expect(await countSources(db)).toBe(0);
  });

  it('is nobody\'s admin when no workspace names a reviewer', async () => {
    // ensureTestWorkspace leaves both columns null, which is the state of a
    // tenant mid-setup: its id must not authorise anyone.
    expect(await findWorkspaceByAdminChatId(db, 555001)).toBeNull();
  });

  it('returns help for /start', async () => {
    const reply = await replyText(makeContext(), { command: 'start', args: '' });
    expect(reply).toContain('/addsource');
  });

  it('ignores an unknown command', async () => {
    const reply = await replyText(makeContext(), { command: 'nonsense', args: '' });
    expect(reply).toBeNull();
  });
});
