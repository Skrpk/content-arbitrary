import { and, asc, eq, isNotNull, TransactionRollbackError } from 'drizzle-orm';
import {
  userIdentities,
  users,
  workspaceMembers,
  workspaces,
  type ReviewLinkTarget,
  type User,
  type Workspace,
} from '@/db/schema';
import type { Database } from '@/lib/db';

/**
 * Who someone is, and which workspaces they may review — the same answer
 * whether they came in through the website or a Mini App.
 */

/** A Telegram account, as a sign-in vouched for it. */
export interface TelegramAccount {
  id: number | string;
  /** Shown, never trusted. */
  name?: string | null;
  username?: string | null;
}

/**
 * The user behind a Telegram account, or null for someone with no business
 * here.
 *
 * A workspace's `telegram_admin_chat_id` names its reviewer. Whoever it names
 * is made a user on first sign-in, and a member of every workspace naming
 * them — every time, so a reviewer set on a workspace later gets it without
 * anyone touching memberships. Someone named nowhere and never made a user is
 * turned away rather than given an empty account.
 */
export async function userForTelegram(
  db: Database,
  account: TelegramAccount,
  options: { recordLogin?: boolean } = {},
): Promise<User | null> {
  const subject = String(account.id);
  const named = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.telegramAdminChatId, subject));

  let user = await findUserByIdentity(db, 'telegram', subject);
  if (!user) {
    if (named.length === 0) return null;
    user = await createUserWithIdentity(db, 'telegram', subject, account);
  }

  if (named.length > 0) {
    await db
      .insert(workspaceMembers)
      .values(named.map((workspace) => ({ workspaceId: workspace.id, userId: user!.id, role: 'owner' as const })))
      .onConflictDoNothing();
  }

  if (options.recordLogin) {
    const now = new Date();
    await db
      .update(userIdentities)
      .set({ lastLoginAt: now, username: account.username ?? null })
      .where(and(eq(userIdentities.provider, 'telegram'), eq(userIdentities.subject, subject)));
    if (account.name) {
      await db.update(users).set({ displayName: account.name, updatedAt: now }).where(eq(users.id, user.id));
      user = { ...user, displayName: account.name };
    }
  }

  return user;
}

/** The workspaces a user may review, oldest first — those with a channel to publish to. */
export async function workspacesForUser(db: Database, userId: number): Promise<Workspace[]> {
  const rows = await db
    .select({ workspace: workspaces })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.userId, userId), isNotNull(workspaces.telegramChatId)))
    .orderBy(asc(workspaces.id));
  return rows.map((row) => row.workspace);
}

/**
 * Where the bot's review buttons should take the person with this Telegram
 * id: their own choice once they are a user, the Mini App before.
 */
export async function reviewLinkFor(db: Database, telegramId: number | string | null): Promise<ReviewLinkTarget> {
  if (telegramId === null || telegramId === '') return 'mini_app';
  const rows = await db
    .select({ reviewLink: users.reviewLink })
    .from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userId))
    .where(and(eq(userIdentities.provider, 'telegram'), eq(userIdentities.subject, String(telegramId))))
    .limit(1);
  return rows[0]?.reviewLink ?? 'mini_app';
}

export async function setReviewLink(db: Database, userId: number, target: ReviewLinkTarget): Promise<void> {
  await db.update(users).set({ reviewLink: target, updatedAt: new Date() }).where(eq(users.id, userId));
}

export async function findUserById(db: Database, id: number): Promise<User | null> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

async function findUserByIdentity(db: Database, provider: 'telegram', subject: string): Promise<User | null> {
  const rows = await db
    .select({ user: users })
    .from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userId))
    .where(and(eq(userIdentities.provider, provider), eq(userIdentities.subject, subject)))
    .limit(1);
  return rows[0]?.user ?? null;
}

/**
 * A new user with this identity. Two first sign-ins at once — a Mini App and
 * the website, say — race on the identity's unique key: the loser's user is
 * rolled back and it reads the winner's.
 */
async function createUserWithIdentity(
  db: Database,
  provider: 'telegram',
  subject: string,
  account: TelegramAccount,
): Promise<User> {
  const created = await db.transaction(async (tx) => {
    const [user] = await tx.insert(users).values({ displayName: account.name ?? null }).returning();
    const identity = await tx
      .insert(userIdentities)
      .values({ userId: user!.id, provider, subject, username: account.username ?? null })
      .onConflictDoNothing()
      .returning();
    if (identity.length === 0) {
      tx.rollback();
    }
    return user!;
  }).catch((error: unknown) => {
    // drizzle's rollback is an error by design; anything else is real.
    if (error instanceof TransactionRollbackError) return null;
    throw error;
  });

  if (created) return created;
  const existing = await findUserByIdentity(db, provider, subject);
  if (!existing) throw new Error('identity vanished while signing in');
  return existing;
}
