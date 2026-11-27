import { and, eq } from 'drizzle-orm';
import { workspaceMembers, workspaces, type Workspace } from '@/db/schema';
import { createUserWithIdentity, findUserByIdentity } from '@/lib/accounts/users';
import type { Database } from '@/lib/db';
import { DIGEST_HOUR_DEFAULT, DIGEST_MINUTES_DEFAULT } from '@/lib/onboarding/limits';
import type { OnboardingLanguage } from '@/lib/onboarding/messages';
import type { User } from '@/db/schema';

/**
 * The person and the workspace for a channel they onboarded (§7).
 *
 * A channel of a workspace they already belong to is that workspace — an
 * operator's included — so onboarding it again refreshes what was learned
 * rather than making a second tenant for the same channel. Otherwise a new
 * self-service workspace: reviewed by them, a daily digest at 09:00, and not
 * connected — nothing is published until they connect the channel
 * (src/lib/publishing/channel.ts).
 */
export async function provisionWorkspace(
  db: Database,
  input: {
    telegramUserId: string;
    name?: string | null;
    username?: string | null;
    channel: { chatId: string; title: string };
    language: OnboardingLanguage;
    now?: Date;
  },
): Promise<{ user: User; workspace: Workspace; created: boolean }> {
  const now = input.now ?? new Date();
  const user =
    (await findUserByIdentity(db, 'telegram', input.telegramUserId)) ??
    (await createUserWithIdentity(db, 'telegram', input.telegramUserId, {
      id: input.telegramUserId,
      name: input.name ?? null,
      username: input.username ?? null,
    }));

  const [existing] = await db
    .select({ workspace: workspaces })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.userId, user.id), eq(workspaces.telegramChatId, input.channel.chatId)))
    .limit(1);
  if (existing) return { user, workspace: existing.workspace, created: false };

  const workspace = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(workspaces)
      .values({
        name: input.channel.title,
        telegramChatId: input.channel.chatId,
        telegramAdminChatId: input.telegramUserId,
        autoPublish: false,
        reviewDigestMinutes: DIGEST_MINUTES_DEFAULT,
        reviewDigestHour: DIGEST_HOUR_DEFAULT,
        reviewDigestTimezone: input.language === 'uk' ? 'Europe/Kyiv' : 'UTC',
        // The first digest at the next 09:00 with something in it, not an empty one now.
        reviewDigestSentAt: now,
        reviewDigestCoveredUntil: now,
        channelVerifiedAt: null,
        createdVia: 'self_service',
      })
      .returning();
    await tx.insert(workspaceMembers).values({ workspaceId: row!.id, userId: user.id, role: 'owner' }).onConflictDoNothing();
    return row!;
  });
  return { user, workspace, created: true };
}

/** Self-service channels this person owns: the cap on onboarding more (WORKSPACES_PER_USER). */
export async function countSelfServiceWorkspaces(db: Database, telegramUserId: string): Promise<number> {
  const user = await findUserByIdentity(db, 'telegram', telegramUserId);
  if (!user) return 0;
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.userId, user.id), eq(workspaces.createdVia, 'self_service')));
  return rows.length;
}
