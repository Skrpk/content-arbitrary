/**
 * The onboarding funnel from product_events (prd-self-service-onboarding.md
 * §29–§30): how many times each event happened, and for how many people, in
 * the last days.
 *
 *   npm run events:funnel                 — the last 7 days
 *   npm run events:funnel -- --days 30
 */
import 'dotenv/config';
import { gt, sql } from 'drizzle-orm';
import { productEvents } from '../src/db/schema';
import { getDb, getSql } from '../src/lib/db';

/** The funnel's order (§30); any other event follows, by name. */
const ORDER = [
  'onboarding.waitlisted',
  'onboarding.started',
  'onboarding.channel_submitted',
  'onboarding.channel_validated',
  'onboarding.history_completed',
  'onboarding.profile_completed',
  'onboarding.discovery_completed',
  'onboarding.sources_activated',
  'onboarding.completed',
  'onboarding.failed',
  'digest.sent',
  'queue.opened',
  'post.previewed',
  'post.rejected',
  'post.approved',
  'publish.blocked',
  'publish.popup_settings',
  'channel.check',
  'channel.connected',
];

async function main() {
  const index = process.argv.indexOf('--days');
  const days = index === -1 ? 7 : Number(process.argv[index + 1]);
  if (!Number.isFinite(days) || days <= 0) throw new Error('Pass a number of days: --days 30');

  const rows = await getDb()
    .select({
      name: productEvents.name,
      events: sql<number>`count(*)`.mapWith(Number),
      people: sql<number>`count(distinct coalesce(${productEvents.userId}::text, ${productEvents.telegramUserId}))`.mapWith(Number),
      channels: sql<number>`count(distinct ${productEvents.workspaceId})`.mapWith(Number),
    })
    .from(productEvents)
    .where(gt(productEvents.occurredAt, new Date(Date.now() - days * 24 * 60 * 60 * 1000)))
    .groupBy(productEvents.name);

  const rank = (name: string) => (ORDER.includes(name) ? ORDER.indexOf(name) : ORDER.length);
  rows.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  console.log(`Last ${days} days\n`);
  console.log(`${'event'.padEnd(32)} ${'events'.padStart(7)} ${'people'.padStart(7)} ${'channels'.padStart(9)}`);
  for (const row of rows) {
    console.log(`${row.name.padEnd(32)} ${String(row.events).padStart(7)} ${String(row.people).padStart(7)} ${String(row.channels).padStart(9)}`);
  }
  if (rows.length === 0) console.log('(none)');
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => getSql().end());
