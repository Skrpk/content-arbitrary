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
import { syncPosts } from '@/lib/sync/sync-posts';
import { addSource, deleteSource, listSources } from '@/lib/sources/repository';
import { claimForDecision, getSyncState, upsertSyncState } from '@/lib/sync/repository';
import { advisoryLockKey } from '@/lib/sync/locks';
import { dispatchCommand } from '@/lib/telegram/commands';
import {
  destinationFor,
  ensureDefaultWorkspace,
  findWorkspacesByAdminChatId,
  listActiveWorkspaces,
} from '@/lib/workspace';
import { XClient } from '@/lib/x/client';
import { TelegramClient } from '@/lib/telegram/client';
import { createTestLogger, instantSleep, withEnv, ensureTestWorkspace, POSTED_AT } from './helpers';

/**
 * Many tenants through one bot and one X application.
 *
 * What has to hold: each tenant publishes only to its own channel, sees only
 * its own sources, keeps its own cursor for an account others may also watch,
 * and cannot act on another tenant's posts. A tenant that is misconfigured or
 * busy is passed over without taking the run down with it.
 */

/** The reply's text, which is what most assertions here are about. */
const replyText = async (...args: Parameters<typeof dispatchCommand>) =>
  (await dispatchCommand(...args))?.text ?? null;

const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

let sql: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

const CHANNEL_A = '-1001000000001';
const CHANNEL_B = '-1002000000002';
const REVIEWER_A = '555001';
const REVIEWER_B = '777002';
/** The one X account every tenant in these tests watches. */
const SHARED_X_ID = '1617323964170125312';

function timelineFor(userId: string, postIds: string[], username = 'shared_account') {
  return {
    data: postIds.map((id) => ({
      id,
      text: `post ${id}`,
      created_at: POSTED_AT,
      author_id: userId,
      attachments: { media_keys: [`m_${id}`] },
    })),
    includes: {
      users: [{ id: userId, username }],
      media: postIds.map((id) => ({
        media_key: `m_${id}`,
        type: 'photo',
        url: `https://cdn.example/${id}.jpg`,
        width: 1200,
        height: 800,
      })),
    },
    meta: {
      result_count: postIds.length,
      newest_id: postIds[0],
      oldest_id: postIds[postIds.length - 1],
    },
  };
}

/** One shared X application: the same stub answers for every tenant. */
function makeXStack(timelines: Record<string, string[]>) {
  const fetched: { userId: string; sinceId: string | null }[] = [];

  const fetchImpl = vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    const userId = url.pathname.split('/')[3]!;
    fetched.push({ userId, sinceId: url.searchParams.get('since_id') });

    return new Response(JSON.stringify(timelineFor(userId, timelines[userId] ?? [])), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  return {
    client: new XClient({
      bearerToken: 'test',
      baseUrl: 'https://api.x.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      attempts: 1,
    }),
    fetched,
  };
}

function makeTelegramStack() {
  const sends: { method: string; chatId: unknown; text?: unknown }[] = [];
  let messageId = 100;

  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);

    if (!url.includes('api.telegram.example')) {
      return new Response(new Uint8Array(128), {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': '128' },
      });
    }

    const method = url.split('/').pop()!;
    const raw = init?.body;
    const body = (
      typeof raw === 'string' ? JSON.parse(raw) : Object.fromEntries((raw as FormData).entries())
    ) as Record<string, unknown>;
    sends.push({ method, chatId: body.chat_id, text: body.text });

    messageId += 1;
    const result =
      method === 'sendMediaGroup'
        ? [{ message_id: messageId, chat: { id: 1 }, photo: [{ file_id: 'F', file_size: 9 }] }]
        : { message_id: messageId, chat: { id: 1 }, photo: [{ file_id: 'F', file_size: 9 }] };

    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const client = new TelegramClient({
    token: '123456:TEST',
    baseUrl: 'https://api.telegram.example',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    attempts: 1,
    sleep: instantSleep,
  });

  return { client, fetchImpl: fetchImpl as unknown as typeof fetch, sends };
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

/** Tenant A is workspace 1; tenant B is created per test. */
const TENANT_B = 2;

async function setUpTenants() {
  await db
    .update(workspaces)
    .set({ telegramChatId: CHANNEL_A, telegramAdminChatId: REVIEWER_A })
    .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));

  await db.insert(workspaces).values({
    id: TENANT_B,
    name: 'second',
    telegramChatId: CHANNEL_B,
    telegramAdminChatId: REVIEWER_B,
    // Not the legacy install, so it must never import the env account.
    legacySourceImportedAt: new Date(),
  });
}

const baseEnv = {
  DRY_RUN: 'false',
  REQUIRE_APPROVAL: 'false',
  TELEGRAM_CHAT_ID: CHANNEL_A,
  TELEGRAM_ADMIN_CHAT_ID: REVIEWER_A,
  TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(64),
  MAX_POSTS_PER_RUN: '5',
  X_USER_ID: undefined,
  X_USERNAME: undefined,
};

async function run(
  x: ReturnType<typeof makeXStack>,
  telegram: ReturnType<typeof makeTelegramStack>,
  env: Record<string, string | undefined> = {},
) {
  return withEnv({ ...baseEnv, ...env }, (parsed) =>
    syncPosts({
      db,
      env: parsed,
      xClient: x.client,
      telegramClient: telegram.client,
      fetchImpl: telegram.fetchImpl,
      logger: createTestLogger(),
      sleep: instantSleep,
      skipLock: true,
    }),
  );
}

describeIfDb('publishing across tenants', () => {
  beforeEach(setUpTenants);

  it('sends each tenant\'s post to its own channel', async () => {
    await addSource(db, { platform: 'x', externalId: '111', username: 'alpha' });
    await addSource(db, {
      platform: 'x',
      externalId: '222',
      username: 'beta',
      workspaceId: TENANT_B,
    });

    const x = makeXStack({ '111': ['1750000000000000011'], '222': ['1750000000000000022'] });
    const telegram = makeTelegramStack();

    const summary = await run(x, telegram);

    expect(summary.published).toBe(2);
    expect(summary.workspaces).toBe(2);

    const channels = telegram.sends.map((send) => send.chatId).sort();
    expect(channels).toEqual([CHANNEL_A, CHANNEL_B].sort());

    // The row records the channel it actually went to, not the env default.
    const rows = await db.select().from(processedPosts);
    const byPost = new Map(rows.map((row) => [row.xPostId, row]));
    expect(byPost.get('1750000000000000011')?.telegramChatId).toBe(CHANNEL_A);
    expect(byPost.get('1750000000000000022')?.telegramChatId).toBe(CHANNEL_B);
    expect(byPost.get('1750000000000000011')?.workspaceId).toBe(DEFAULT_WORKSPACE_ID);
    expect(byPost.get('1750000000000000022')?.workspaceId).toBe(TENANT_B);
  });

  it('starts with the tenant that has waited longest', async () => {
    await addSource(db, { platform: 'x', externalId: '111', username: 'alpha' });
    await addSource(db, { platform: 'x', externalId: '222', username: 'beta', workspaceId: TENANT_B });
    // Tenant 1 comes first by id, but tenant 2 has gone longer without a sync.
    await upsertSyncState(db, { source: 'x:111', lastSyncAt: new Date('2026-10-06T10:30:00Z') });
    await upsertSyncState(db, {
      source: 'x:222',
      workspaceId: TENANT_B,
      lastSyncAt: new Date('2026-10-06T10:00:00Z'),
    });

    const x = makeXStack({});
    await run(x, makeTelegramStack());

    expect(x.fetched.map((fetch) => fetch.userId)).toEqual(['222', '111']);
  });

  /**
   * The headline case for this installation: one X account, several channels.
   * Both tenants must receive the post, each into its own channel, and each
   * keep its own cursor.
   */
  it('gives both tenants the same account\'s post, once each', async () => {
    await addSource(db, { platform: 'x', externalId: SHARED_X_ID, username: 'shared_account' });
    await addSource(db, {
      platform: 'x',
      externalId: SHARED_X_ID,
      username: 'shared_account',
      workspaceId: TENANT_B,
    });

    const x = makeXStack({ [SHARED_X_ID]: ['1750000000000000099'] });
    const telegram = makeTelegramStack();

    const summary = await run(x, telegram);

    expect(summary.published).toBe(2);
    expect(telegram.sends.map((send) => send.chatId).sort()).toEqual(
      [CHANNEL_A, CHANNEL_B].sort(),
    );

    // Two rows for one X post: the composite unique key allows exactly this.
    const rows = await db
      .select()
      .from(processedPosts)
      .where(eq(processedPosts.xPostId, '1750000000000000099'));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.workspaceId).sort()).toEqual([DEFAULT_WORKSPACE_ID, TENANT_B]);

    // And a cursor each, rather than one they both move.
    expect((await getSyncState(db, `x:${SHARED_X_ID}`, DEFAULT_WORKSPACE_ID))?.lastSeenPostId)
      .toBe('1750000000000000099');
    expect((await getSyncState(db, `x:${SHARED_X_ID}`, TENANT_B))?.lastSeenPostId)
      .toBe('1750000000000000099');

    // Shared X application: billed per tenant, so two reads for one account.
    expect(x.fetched.filter((call) => call.userId === SHARED_X_ID)).toHaveLength(2);
  });

  it('does not re-send a post the tenant already published', async () => {
    await addSource(db, { platform: 'x', externalId: SHARED_X_ID, username: 'shared_account' });
    await addSource(db, {
      platform: 'x',
      externalId: SHARED_X_ID,
      username: 'shared_account',
      workspaceId: TENANT_B,
    });

    const x = makeXStack({ [SHARED_X_ID]: ['1750000000000000099'] });
    await run(x, makeTelegramStack());

    const second = makeTelegramStack();
    const summary = await run(makeXStack({ [SHARED_X_ID]: ['1750000000000000099'] }), second);

    expect(summary.published).toBe(0);
    expect(second.sends).toHaveLength(0);
  });
});

describeIfDb('tenants that cannot publish', () => {
  it('skips a tenant with no channel and names the reason', async () => {
    await setUpTenants();
    await db
      .update(workspaces)
      .set({ telegramChatId: null })
      .where(eq(workspaces.id, TENANT_B));

    await addSource(db, { platform: 'x', externalId: '111', username: 'alpha' });
    await addSource(db, {
      platform: 'x',
      externalId: '222',
      username: 'beta',
      workspaceId: TENANT_B,
    });

    const x = makeXStack({ '111': ['1750000000000000011'], '222': ['1750000000000000022'] });
    const telegram = makeTelegramStack();

    const summary = await run(x, telegram);

    // Tenant A still ran; tenant B's account was never even fetched.
    expect(summary.published).toBe(1);
    expect(x.fetched.map((call) => call.userId)).toEqual(['111']);
    expect(telegram.sends.every((send) => send.chatId === CHANNEL_A)).toBe(true);
    // A tenant with no destination is not listed as active at all.
    expect((await listActiveWorkspaces(db)).map((tenant) => tenant.id)).toEqual([
      DEFAULT_WORKSPACE_ID,
    ]);
  });

  it('refuses to publish for a reviewerless tenant while approval is required', async () => {
    await setUpTenants();
    await db
      .update(workspaces)
      .set({ telegramAdminChatId: null })
      .where(eq(workspaces.id, TENANT_B));

    await addSource(db, {
      platform: 'x',
      externalId: '222',
      username: 'beta',
      workspaceId: TENANT_B,
    });

    const x = makeXStack({ '222': ['1750000000000000022'] });
    const telegram = makeTelegramStack();

    const summary = await run(x, telegram, { REQUIRE_APPROVAL: 'true' });

    // Approval on with nobody to approve must not fall through to the channel.
    expect(summary.published).toBe(0);
    expect(summary.awaitingApproval).toBe(0);
    expect(telegram.sends).toHaveLength(0);
    expect(summary.skippedWorkspaces).toEqual([
      {
        workspaceId: TENANT_B,
        reason: 'REQUIRE_APPROVAL is on but workspace has no telegram_admin_chat_id',
      },
    ]);
  });

  it('publishes for that same tenant once approval is off', async () => {
    await setUpTenants();
    await db
      .update(workspaces)
      .set({ telegramAdminChatId: null })
      .where(eq(workspaces.id, TENANT_B));

    await addSource(db, {
      platform: 'x',
      externalId: '222',
      username: 'beta',
      workspaceId: TENANT_B,
    });

    const summary = await run(makeXStack({ '222': ['1750000000000000022'] }), makeTelegramStack());
    expect(summary.published).toBe(1);
  });
});

describeIfDb('tenant isolation', () => {
  beforeEach(setUpTenants);

  it('shows a reviewer only their own sources', async () => {
    await addSource(db, { platform: 'x', externalId: '111', username: 'alpha' });
    await addSource(db, {
      platform: 'x',
      externalId: '222',
      username: 'beta',
      workspaceId: TENANT_B,
    });

    const contextFor = (workspaceId: number) => ({
      db,
      xClient: new XClient({
        bearerToken: 'test',
        baseUrl: 'https://api.x.example',
        fetchImpl: vi.fn() as unknown as typeof fetch,
        attempts: 1,
      }),
      logger: createTestLogger(),
      workspaceId,
    });

    const replyA = await replyText(contextFor(DEFAULT_WORKSPACE_ID), {
      command: 'sources',
      args: '',
    });
    const replyB = await replyText(contextFor(TENANT_B), { command: 'sources', args: '' });

    expect(replyA).toContain('@alpha');
    expect(replyA).not.toContain('@beta');
    expect(replyB).toContain('@beta');
    expect(replyB).not.toContain('@alpha');
  });

  it('will not let a reviewer remove another tenant\'s source', async () => {
    const { source } = await addSource(db, { platform: 'x', externalId: '111', username: 'alpha' });

    expect(await deleteSource(db, { id: source.id, workspaceIds: [TENANT_B] })).toBeNull();
    expect(await listSources(db, DEFAULT_WORKSPACE_ID)).toHaveLength(1);
  });

  /**
   * A button press carries only a post id. Without scoping the claim, a
   * reviewer could publish another tenant's post into their own channel simply
   * by sending a callback for an id that was never theirs.
   */
  it('will not let a reviewer decide another tenant\'s post', async () => {
    await addSource(db, { platform: 'x', externalId: SHARED_X_ID, username: 'shared_account' });

    const x = makeXStack({ [SHARED_X_ID]: ['1750000000000000099'] });
    await run(x, makeTelegramStack(), { REQUIRE_APPROVAL: 'true' });

    const row = (await db.select().from(processedPosts))[0]!;
    expect(row.status).toBe('awaiting_approval');
    expect(row.workspaceId).toBe(DEFAULT_WORKSPACE_ID);

    // Tenant B's reviewer presses Approve on tenant A's post.
    const stolen = await claimForDecision(db, row.id, TENANT_B);
    expect(stolen.claimed).toBe(false);

    // The post is untouched and still awaiting its own reviewer.
    const after = (await db.select().from(processedPosts).where(eq(processedPosts.id, row.id)))[0];
    expect(after?.status).toBe('awaiting_approval');

    const owner = await claimForDecision(db, row.id, DEFAULT_WORKSPACE_ID);
    expect(owner.claimed).toBe(true);
  });

  it('resolves each reviewer to their own tenant', async () => {
    const ids = async (reviewer: string) =>
      (await findWorkspacesByAdminChatId(db, reviewer)).map((workspace) => workspace.id);

    expect(await ids(REVIEWER_A)).toEqual([DEFAULT_WORKSPACE_ID]);
    expect(await ids(REVIEWER_B)).toEqual([TENANT_B]);
    expect(await ids('999999')).toEqual([]);
  });

  it('locks tenants separately', async () => {
    // One lock per tenant, so a slow tenant cannot hold up the others.
    expect(advisoryLockKey('content-arbitrary:sync:1')).not.toBe(
      advisoryLockKey('content-arbitrary:sync:2'),
    );
  });
});

describeIfDb('the environment seeds tenant 1 only', () => {
  it('fills in a destination the row does not have yet', async () => {
    const seeded = await withEnv(baseEnv, (env) => ensureDefaultWorkspace(db, env));

    expect(seeded.telegramChatId).toBe(CHANNEL_A);
    expect(seeded.telegramAdminChatId).toBe(REVIEWER_A);
  });

  /**
   * Seed, not mirror. An operator who repoints a tenant in the database must
   * not have the environment quietly overwrite it on the next cron run.
   */
  it('leaves a destination the operator has changed', async () => {
    await withEnv(baseEnv, (env) => ensureDefaultWorkspace(db, env));

    await db
      .update(workspaces)
      .set({ telegramChatId: CHANNEL_B, telegramAdminChatId: REVIEWER_B })
      .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));

    const again = await withEnv(baseEnv, (env) => ensureDefaultWorkspace(db, env));

    expect(again.telegramChatId).toBe(CHANNEL_B);
    expect(again.telegramAdminChatId).toBe(REVIEWER_B);
  });

  /**
   * Once the row is set up the variables are unused, so removing them from the
   * deployment must change nothing — least of all empty a live channel.
   */
  it('keeps a configured tenant 1 when the variables are removed', async () => {
    await withEnv(baseEnv, (env) => ensureDefaultWorkspace(db, env));

    const after = await withEnv(
      { ...baseEnv, TELEGRAM_CHAT_ID: undefined, TELEGRAM_ADMIN_CHAT_ID: undefined },
      (env) => ensureDefaultWorkspace(db, env),
    );

    expect(after.telegramChatId).toBe(CHANNEL_A);
    expect(after.telegramAdminChatId).toBe(REVIEWER_A);
  });

  it('leaves tenant 1 unconfigured, and skipped, on an install without the variables', async () => {
    const seeded = await withEnv(
      {
        ...baseEnv,
        REQUIRE_APPROVAL: 'true',
        TELEGRAM_CHAT_ID: undefined,
        TELEGRAM_ADMIN_CHAT_ID: undefined,
      },
      async (env) => {
        const workspace = await ensureDefaultWorkspace(db, env);
        return { workspace, destination: destinationFor(workspace, env) };
      },
    );

    expect(seeded.workspace.telegramChatId).toBeNull();
    expect(seeded.workspace.telegramAdminChatId).toBeNull();
    expect(seeded.destination).toEqual({ ok: false, reason: 'workspace has no telegram_chat_id' });
  });

  it('never seeds a second tenant from the environment', async () => {
    await db.insert(workspaces).values({ id: TENANT_B, name: 'second' });

    await withEnv(baseEnv, (env) => ensureDefaultWorkspace(db, env));

    const rows = await db.select().from(workspaces).where(eq(workspaces.id, TENANT_B));
    expect(rows[0]?.telegramChatId).toBeNull();
    expect(await withEnv(baseEnv, (env) => destinationFor(rows[0]!, env)).then((r) => r.ok)).toBe(
      false,
    );
  });
});

describeIfDb('one reviewer for two channels', () => {
  beforeEach(setUpTenants);

  /** The control message under each review: the one carrying the buttons. */
  const controlTexts = (telegram: ReturnType<typeof makeTelegramStack>) =>
    telegram.sends
      .filter((send) => send.method === 'sendMessage')
      .map((send) => String(send.text));

  it('names the channel on each review, so the reviewer can tell them apart', async () => {
    await db.update(workspaces).set({ name: 'Alpha' }).where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
    await db
      .update(workspaces)
      .set({ name: 'Beta', telegramAdminChatId: REVIEWER_A })
      .where(eq(workspaces.id, TENANT_B));
    await addSource(db, { platform: 'x', externalId: SHARED_X_ID, username: 'shared_account' });
    await addSource(db, {
      platform: 'x',
      externalId: SHARED_X_ID,
      username: 'shared_account',
      workspaceId: TENANT_B,
    });

    const telegram = makeTelegramStack();
    await run(makeXStack({ [SHARED_X_ID]: ['1750000000000000301'] }), telegram, {
      REQUIRE_APPROVAL: 'true',
    });

    // Both reviews went to the one reviewer, each labelled with its channel.
    expect(telegram.sends.every((send) => send.chatId === REVIEWER_A)).toBe(true);
    const texts = controlTexts(telegram);
    expect(texts).toHaveLength(2);
    expect(texts.some((text) => text.startsWith('📢 Alpha\n'))).toBe(true);
    expect(texts.some((text) => text.startsWith('📢 Beta\n'))).toBe(true);
  });

  it('adds no label for a reviewer of a single channel', async () => {
    await addSource(db, { platform: 'x', externalId: SHARED_X_ID, username: 'shared_account' });

    const telegram = makeTelegramStack();
    await run(makeXStack({ [SHARED_X_ID]: ['1750000000000000302'] }), telegram, {
      REQUIRE_APPROVAL: 'true',
    });

    const texts = controlTexts(telegram);
    expect(texts).toHaveLength(1);
    expect(texts[0]).not.toContain('📢');
  });
});
