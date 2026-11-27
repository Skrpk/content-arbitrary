import { and, eq, gt } from 'drizzle-orm';
import { botPendingInputs, type BotPendingInput, type BotPendingInputKind } from '@/db/schema';
import type { Database } from '@/lib/db';

/**
 * What the bot waits for next in someone's private chat (§14a): one row per
 * person, replaced by the next prompt, gone after 15 minutes or once used.
 */

export const PENDING_INPUT_TTL_MS = 15 * 60 * 1000;

/** Wait for this person's next message: replaces whatever was awaited before. */
export async function awaitInput(
  db: Database,
  input: { telegramUserId: string; kind: BotPendingInputKind; workspaceId: number; payload?: { draft?: string }; now?: Date },
): Promise<BotPendingInput> {
  const now = input.now ?? new Date();
  const values = {
    kind: input.kind,
    workspaceId: input.workspaceId,
    payload: input.payload ?? {},
    expiresAt: new Date(now.getTime() + PENDING_INPUT_TTL_MS),
    createdAt: now,
  };
  const [row] = await db
    .insert(botPendingInputs)
    .values({ telegramUserId: input.telegramUserId, ...values })
    .onConflictDoUpdate({ target: botPendingInputs.telegramUserId, set: values })
    .returning();
  return row!;
}

/** What this person's next message is for, unless it has lapsed. */
export async function pendingInputOf(db: Database, telegramUserId: string, now = new Date()): Promise<BotPendingInput | null> {
  const [row] = await db
    .select()
    .from(botPendingInputs)
    .where(and(eq(botPendingInputs.telegramUserId, telegramUserId), gt(botPendingInputs.expiresAt, now)));
  return row ?? null;
}

/** Stop waiting: a command was sent, the input was used, or it was cancelled. */
export async function clearPendingInput(db: Database, telegramUserId: string): Promise<void> {
  await db.delete(botPendingInputs).where(eq(botPendingInputs.telegramUserId, telegramUserId));
}
