/**
 * The onboarding waitlist (prd-self-service-onboarding.md §28): who asked to
 * onboard a channel and could not, and letting them in.
 *
 *   npm run onboarding:waitlist                     — who is waiting, longest first
 *   npm run onboarding:waitlist -- --all            — the admitted too
 *   npm run onboarding:waitlist -- --admit <id>     — let a Telegram user in, and tell them
 *
 * Admitting lets someone in past ONBOARDING_ALLOWLIST, never past the caps
 * (ONBOARDING_MAX_WORKSPACES, ONBOARDING_MAX_RUNS_PER_DAY): raise those in
 * the environment when they are what keeps people out.
 */
import 'dotenv/config';
import { z } from 'zod';
import { getDb, getSql } from '../src/lib/db';
import { getEnv } from '../src/lib/env';
import { createLogger } from '../src/lib/logger';
import { admitFromWaitlist, capReached, waitlistEntries } from '../src/lib/onboarding/access';
import { copy, type OnboardingLanguage } from '../src/lib/onboarding/messages';
import { TelegramClient } from '../src/lib/telegram/client';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const env = getEnv();
  const db = getDb();
  const admit = argument('admit');

  if (admit !== undefined) {
    if (!/^\d{1,15}$/.test(admit)) throw new Error('Pass a Telegram user id: --admit 123456789');
    const entry = await admitFromWaitlist(db, admit);
    if (!entry) throw new Error(`${admit} is not waiting (not on the list, or admitted already)`);
    const logger = createLogger({ app: 'content-arbitrary', surface: 'onboarding-waitlist' });
    await new TelegramClient({ logger })
      .call('sendMessage', { chat_id: entry.chatId, text: copy(entry.language as OnboardingLanguage).admitted }, z.object({ message_id: z.number() }))
      .then(() => console.log(`Admitted ${admit} (${entry.username ? `@${entry.username}` : entry.name ?? 'no name'}) and told them.`))
      .catch((error: unknown) => console.log(`Admitted ${admit}, but could not tell them: ${String(error)}`));
    const cap = await capReached(db, env);
    if (cap) console.log(`Note: onboarding is at a cap (${cap}) — they will be waitlisted again until it is raised.`);
    return;
  }

  const entries = await waitlistEntries(db, { all: process.argv.includes('--all') });
  if (entries.length === 0) {
    console.log('Nobody is waiting.');
    return;
  }
  for (const entry of entries) {
    const who = [entry.username ? `@${entry.username}` : null, entry.name].filter(Boolean).join(' · ') || '—';
    const admitted = entry.admittedAt ? `  admitted ${entry.admittedAt.toISOString().slice(0, 10)}` : '';
    console.log(`${entry.telegramUserId.padEnd(12)} ${who.padEnd(32)} ${entry.reason.padEnd(15)} since ${entry.createdAt.toISOString().slice(0, 10)}${admitted}`);
  }
  console.log(`\n${entries.length} ${entries.length === 1 ? 'person' : 'people'}. Admit one: npm run onboarding:waitlist -- --admit <id>`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => getSql().end());
