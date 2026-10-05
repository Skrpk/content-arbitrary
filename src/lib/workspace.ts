import { and, eq, isNotNull, sql as rawSql } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import type { Env } from '@/lib/env';
import type { Logger } from '@/lib/logger';
import { DEFAULT_WORKSPACE_ID, workspaces, type Workspace } from '@/db/schema';

/**
 * A workspace is one tenant: a destination channel and the reviewer who
 * approves for it. Sources, posts and cursors all hang off it.
 *
 * The environment seeds workspace 1 and nothing else. It is deliberately not a
 * mirror: once a row has a destination, the row is authoritative, so an
 * operator who repoints a tenant's channel in the database does not have it
 * silently overwritten on the next cron run.
 *
 * What stays global, because every tenant shares one X application: the X
 * bearer token, the bot token, and the sync tuning (MAX_POSTS_PER_RUN,
 * REQUIRE_APPROVAL and friends).
 */

/** Everything a publish needs to know about where a post is going. */
export interface TelegramDestination {
  workspaceId: number;
  /** The channel posts are published to. */
  chatId: string;
  /** The reviewer's private chat; null when this tenant has no reviewer. */
  adminChatId: string | null;
  disableNotification: boolean;
}

/**
 * Seed workspace 1 from the environment.
 *
 * `COALESCE` is the whole point: a column the row already has is kept, and only
 * a NULL is filled in from env. An install upgrading from the single-tenant
 * configuration therefore gets its channel copied in once, and every later run
 * leaves the row alone.
 */
export async function ensureDefaultWorkspace(
  db: Database,
  env: Env,
  logger?: Logger,
): Promise<Workspace> {
  const rows = await db
    .insert(workspaces)
    .values({
      id: DEFAULT_WORKSPACE_ID,
      name: 'default',
      telegramChatId: env.TELEGRAM_CHAT_ID,
      telegramAdminChatId: env.TELEGRAM_ADMIN_CHAT_ID ?? null,
    })
    .onConflictDoUpdate({
      target: workspaces.id,
      set: {
        telegramChatId: rawSql`coalesce(${workspaces.telegramChatId}, ${env.TELEGRAM_CHAT_ID})`,
        telegramAdminChatId: rawSql`coalesce(${workspaces.telegramAdminChatId}, ${
          env.TELEGRAM_ADMIN_CHAT_ID ?? null
        })`,
      },
    })
    .returning();

  const workspace = rows[0];
  if (workspace) return workspace;

  // A concurrent run won the insert; read what it wrote.
  const existing = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID))
    .limit(1);

  const found = existing[0];
  if (!found) {
    logger?.error('workspace.missing', { id: DEFAULT_WORKSPACE_ID });
    throw new Error(`Default workspace ${DEFAULT_WORKSPACE_ID} is missing; run migrations`);
  }

  return found;
}

/**
 * Tenants a sync run should visit, oldest first so the order is stable.
 *
 * A workspace with no channel is left out rather than failed: it is a tenant
 * mid-setup, and there is nowhere for its posts to go yet.
 */
export async function listActiveWorkspaces(db: Database): Promise<Workspace[]> {
  return db
    .select()
    .from(workspaces)
    .where(isNotNull(workspaces.telegramChatId))
    .orderBy(workspaces.id);
}

/**
 * Every tenant, including ones with no destination yet.
 *
 * Distinct from listActiveWorkspaces on purpose: a sync must skip a tenant that
 * cannot publish, while an operator looking at /api/status needs to see exactly
 * that tenant and why it is idle.
 */
export async function listAllWorkspaces(db: Database): Promise<Workspace[]> {
  return db.select().from(workspaces).orderBy(workspaces.id);
}

/**
 * The tenant a Telegram user reviews for.
 *
 * This is the whole authorisation rule for the webhook: a user is an admin
 * exactly when some workspace names them as its reviewer. Nobody else can
 * manage sources or publish, however the message reached them.
 */
export async function findWorkspaceByAdminChatId(
  db: Database,
  adminChatId: number | string | undefined,
): Promise<Workspace | null> {
  if (adminChatId === undefined || adminChatId === null || adminChatId === '') return null;

  const rows = await db
    .select()
    .from(workspaces)
    .where(
      and(
        eq(workspaces.telegramAdminChatId, String(adminChatId)),
        isNotNull(workspaces.telegramChatId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function findWorkspaceById(db: Database, id: number): Promise<Workspace | null> {
  const rows = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Turn a workspace row into a publish destination, or explain why it cannot
 * publish yet. Returning the reason keeps the decision out of the caller.
 */
export function destinationFor(
  workspace: Workspace,
  env: Env,
): { ok: true; destination: TelegramDestination } | { ok: false; reason: string } {
  if (!workspace.telegramChatId) {
    return { ok: false, reason: 'workspace has no telegram_chat_id' };
  }

  if (env.REQUIRE_APPROVAL && !workspace.telegramAdminChatId) {
    // Publishing straight to the channel would quietly bypass review, which is
    // the one thing approval exists to prevent.
    return {
      ok: false,
      reason: 'REQUIRE_APPROVAL is on but workspace has no telegram_admin_chat_id',
    };
  }

  return {
    ok: true,
    destination: {
      workspaceId: workspace.id,
      chatId: workspace.telegramChatId,
      adminChatId: workspace.telegramAdminChatId,
      disableNotification: env.TELEGRAM_DISABLE_NOTIFICATION,
    },
  };
}

/**
 * Record that this workspace has imported its legacy environment source.
 *
 * Written once, right after the import succeeds, and never cleared — removing
 * the source is a decision the admin should not have undone for them on the
 * next cron run.
 */
export async function markLegacySourceImported(
  db: Database,
  workspaceId: number = DEFAULT_WORKSPACE_ID,
): Promise<void> {
  await db
    .update(workspaces)
    .set({ legacySourceImportedAt: new Date(), updatedAt: new Date() })
    .where(eq(workspaces.id, workspaceId));
}
