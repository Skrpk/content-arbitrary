/**
 * Where a decided post goes: its Telegram channel, the channel's Threads
 * account, or both. The reviewer chooses when the channel has a Threads
 * account connected; without one there is nothing to choose, and it is
 * Telegram.
 */

export const PUBLISH_TARGETS = ['telegram', 'threads'] as const;
export type PublishTarget = (typeof PUBLISH_TARGETS)[number];

/** Both, unless the reviewer unticks one. */
export const DEFAULT_PUBLISH_TARGETS: PublishTarget[] = ['telegram', 'threads'];

export function isPublishTarget(value: unknown): value is PublishTarget {
  return typeof value === 'string' && (PUBLISH_TARGETS as readonly string[]).includes(value);
}

/**
 * The targets as stored, in a fixed order and without repeats; null or empty
 * stands for Telegram alone, as every post decided before there was a choice.
 */
export function normalizeTargets(targets: readonly string[] | null | undefined): PublishTarget[] {
  const chosen = PUBLISH_TARGETS.filter((target) => targets?.includes(target));
  return chosen.length > 0 ? chosen : ['telegram'];
}

/** What a reviewer may ask for: Threads only where an account is connected. */
export function allowedTargets(chosen: readonly string[], threadsConnected: boolean): PublishTarget[] | null {
  const targets = normalizeTargets(chosen);
  if (targets.includes('threads') && !threadsConnected) return null;
  return targets;
}

export function describeTargets(targets: readonly PublishTarget[]): string {
  return targets.map((target) => (target === 'telegram' ? 'Telegram' : 'Threads')).join(' and ');
}

/** The reviewer's notice once a decided post is on its way. */
export function publishedNotice(targets: readonly PublishTarget[]): string {
  if (!targets.includes('threads')) return 'Published to the channel.';
  return targets.includes('telegram') ? 'Published to the channel; on its way to Threads.' : 'On its way to Threads.';
}

/** The line a review message is settled with. */
export function publishedLine(targets: readonly PublishTarget[]): string {
  if (!targets.includes('threads')) return '✅ Published';
  return targets.includes('telegram') ? '✅ Published · 🧵 Threads: on its way' : '✅ 🧵 Threads: on its way';
}
