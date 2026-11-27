import { and, asc, eq, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import { onboardingSessions, type OnboardingSession, type OnboardingStatus } from '@/db/schema';
import type { Database } from '@/lib/db';
import type { OnboardingLanguage } from '@/lib/onboarding/messages';

/** The statuses a runner works on; the rest wait for the person, or are over. */
export const RUNNABLE_STATUSES: OnboardingStatus[] = ['analyzing_history', 'profiling', 'discovering_sources', 'activating_sources'];
const CLOSED: OnboardingStatus[] = ['active', 'failed'];

/** This person's onboarding still in progress, if any. */
export async function findOpenSession(db: Database, telegramUserId: string): Promise<OnboardingSession | null> {
  const rows = await db
    .select()
    .from(onboardingSessions)
    .where(and(eq(onboardingSessions.telegramUserId, telegramUserId), notInArray(onboardingSessions.status, CLOSED)))
    .limit(1);
  return rows[0] ?? null;
}

/** A new onboarding, awaiting the channel — or the one already open, when two /start race. */
export async function openSession(
  db: Database,
  input: { telegramUserId: string; chatId: string; language: OnboardingLanguage },
): Promise<OnboardingSession> {
  const [created] = await db.insert(onboardingSessions).values(input).onConflictDoNothing().returning();
  if (created) return created;
  const open = await findOpenSession(db, input.telegramUserId);
  if (!open) throw new Error('onboarding session vanished while opening it');
  return open;
}

export async function updateSession(
  db: Database,
  id: number,
  patch: Partial<Omit<typeof onboardingSessions.$inferInsert, 'id'>>,
): Promise<OnboardingSession | null> {
  const [row] = await db
    .update(onboardingSessions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(onboardingSessions.id, id))
    .returning();
  return row ?? null;
}

/**
 * Take a session's current step for `leaseMs`: a single conditional UPDATE,
 * so of two runners only one gets it. Null when it is not runnable now —
 * waiting on the person, over, held by another runner, or backing off.
 */
export async function claimStep(db: Database, id: number, now: Date, leaseMs: number): Promise<OnboardingSession | null> {
  const [row] = await db
    .update(onboardingSessions)
    .set({
      lockedUntil: new Date(now.getTime() + leaseMs),
      attempts: sql`${onboardingSessions.attempts} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(onboardingSessions.id, id),
        inArray(onboardingSessions.status, RUNNABLE_STATUSES),
        or(isNull(onboardingSessions.lockedUntil), lte(onboardingSessions.lockedUntil, now)),
        or(isNull(onboardingSessions.nextAttemptAt), lte(onboardingSessions.nextAttemptAt, now)),
      ),
    )
    .returning();
  return row ?? null;
}

/** Sessions with a step to run now — new, retrying, or whose runner died — oldest first. */
export async function runnableSessionIds(db: Database, now: Date, limit: number): Promise<number[]> {
  const rows = await db
    .select({ id: onboardingSessions.id })
    .from(onboardingSessions)
    .where(
      and(
        inArray(onboardingSessions.status, RUNNABLE_STATUSES),
        or(isNull(onboardingSessions.lockedUntil), lte(onboardingSessions.lockedUntil, now)),
        or(isNull(onboardingSessions.nextAttemptAt), lte(onboardingSessions.nextAttemptAt, now)),
      ),
    )
    .orderBy(asc(onboardingSessions.updatedAt))
    .limit(limit);
  return rows.map((row) => row.id);
}
