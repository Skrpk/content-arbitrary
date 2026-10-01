import { eq } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import type { Env } from '@/lib/env';
import type { Logger } from '@/lib/logger';
import { DEFAULT_WORKSPACE_ID, workspaces, type Workspace } from '@/db/schema';

/**
 * The single tenant this installation serves.
 *
 * Multi-tenancy is not implemented: the runtime still reads the destination
 * channel and the reviewer from the environment. What exists today is the row
 * they will eventually come from, kept in step with the environment so the
 * switch is a change of reader rather than a data migration.
 *
 * The scoping columns matter more than the row. Adding `workspace_id` and
 * turning the global `UNIQUE (x_post_id)` into `UNIQUE (workspace_id,
 * x_post_id)` is cheap now and expensive later: after a second tenant exists,
 * the same X post legitimately belongs to two channels, and a global unique
 * index would reject the second one — a constraint that cannot be changed under
 * live traffic without dropping duplicate protection while it rebuilds.
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
      // Env stays authoritative for now, so mirror it rather than let the row
      // drift into a second, silently disagreeing source of truth.
      set: {
        telegramChatId: env.TELEGRAM_CHAT_ID,
        telegramAdminChatId: env.TELEGRAM_ADMIN_CHAT_ID ?? null,
        updatedAt: new Date(),
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
