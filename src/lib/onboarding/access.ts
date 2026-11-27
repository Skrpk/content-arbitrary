import { and, count, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import { onboardingSessions, onboardingWaitlist, workspaces, type OnboardingWaitlistEntry } from '@/db/schema';
import type { Database } from '@/lib/db';
import type { Env } from '@/lib/env';
import type { OnboardingLanguage } from '@/lib/onboarding/messages';

/**
 * Who may onboard a channel now (§28, D5): the alpha's allowlist — or an
 * admission from the waitlist — and, for everyone, two global caps: the
 * self-service channels in all, and the channels onboarded in a day. Anyone
 * refused goes on the waitlist, to be let in later.
 */

export type WaitlistReason = OnboardingWaitlistEntry['reason'];

export type OnboardingAccess =
  /** Onboarding is off: no allowlist at all. The bot answers as it always did. */
  | { ok: false; reason: 'off' }
  | { ok: false; reason: WaitlistReason }
  | { ok: true };

type AccessEnv = Pick<Env, 'ONBOARDING_ALLOWLIST' | 'ONBOARDING_MAX_WORKSPACES' | 'ONBOARDING_MAX_RUNS_PER_DAY'>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether onboarding answers anyone at all. */
export function onboardingOn(env: Pick<Env, 'ONBOARDING_ALLOWLIST'>): boolean {
  return env.ONBOARDING_ALLOWLIST.length > 0;
}

export async function onboardingAccess(db: Database, env: AccessEnv, telegramUserId: string, now = new Date()): Promise<OnboardingAccess> {
  if (!onboardingOn(env)) return { ok: false, reason: 'off' };
  const listed =
    env.ONBOARDING_ALLOWLIST.includes('*') || env.ONBOARDING_ALLOWLIST.includes(telegramUserId) || (await admitted(db, telegramUserId));
  if (!listed) return { ok: false, reason: 'not_listed' };
  const cap = await capReached(db, env, now);
  return cap ? { ok: false, reason: cap } : { ok: true };
}

/** A global cap onboarding is at, if any: checked again when the channel arrives, since others may have onboarded meanwhile. */
export async function capReached(
  db: Database,
  env: Pick<Env, 'ONBOARDING_MAX_WORKSPACES' | 'ONBOARDING_MAX_RUNS_PER_DAY'>,
  now = new Date(),
): Promise<'workspaces_cap' | 'runs_cap' | null> {
  const [selfService] = await db.select({ n: count() }).from(workspaces).where(eq(workspaces.createdVia, 'self_service'));
  if ((selfService?.n ?? 0) >= env.ONBOARDING_MAX_WORKSPACES) return 'workspaces_cap';
  // A run is a session that got a channel: one waiting for it costs nothing.
  const [runs] = await db
    .select({ n: count() })
    .from(onboardingSessions)
    .where(and(isNotNull(onboardingSessions.channelChatId), gt(onboardingSessions.startedAt, new Date(now.getTime() - DAY_MS))));
  if ((runs?.n ?? 0) >= env.ONBOARDING_MAX_RUNS_PER_DAY) return 'runs_cap';
  return null;
}

async function admitted(db: Database, telegramUserId: string): Promise<boolean> {
  const [row] = await db
    .select({ at: onboardingWaitlist.admittedAt })
    .from(onboardingWaitlist)
    .where(and(eq(onboardingWaitlist.telegramUserId, telegramUserId), isNotNull(onboardingWaitlist.admittedAt)));
  return Boolean(row);
}

/** Put someone on the waitlist, or note that they asked again — and why they could not get in this time. */
export async function addToWaitlist(
  db: Database,
  input: {
    telegramUserId: string;
    chatId: string;
    language: OnboardingLanguage;
    username: string | null;
    name: string | null;
    reason: WaitlistReason;
    now?: Date;
  },
): Promise<OnboardingWaitlistEntry> {
  const now = input.now ?? new Date();
  const values = {
    chatId: input.chatId,
    language: input.language,
    username: input.username,
    name: input.name,
    reason: input.reason,
    updatedAt: now,
  };
  const [row] = await db
    .insert(onboardingWaitlist)
    .values({ telegramUserId: input.telegramUserId, ...values, createdAt: now })
    .onConflictDoUpdate({ target: onboardingWaitlist.telegramUserId, set: values })
    .returning();
  return row!;
}

/** Let someone in past the allowlist. Returns their entry when this call admitted them; null when absent or admitted already. */
export async function admitFromWaitlist(db: Database, telegramUserId: string, now = new Date()): Promise<OnboardingWaitlistEntry | null> {
  const [row] = await db
    .update(onboardingWaitlist)
    .set({ admittedAt: now, updatedAt: now })
    .where(and(eq(onboardingWaitlist.telegramUserId, telegramUserId), isNull(onboardingWaitlist.admittedAt)))
    .returning();
  return row ?? null;
}

/** Everyone waiting, longest first; admitted ones too with `all`. */
export async function waitlistEntries(db: Database, options: { all?: boolean } = {}): Promise<OnboardingWaitlistEntry[]> {
  const rows = await db
    .select()
    .from(onboardingWaitlist)
    .where(options.all ? undefined : isNull(onboardingWaitlist.admittedAt))
    .orderBy(onboardingWaitlist.createdAt);
  return rows;
}
