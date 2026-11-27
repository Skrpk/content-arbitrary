/**
 * The bounds of self-service onboarding, in one place. See the PRD,
 * prd-self-service-onboarding.md §28.
 */

/** The channel's latest usable posts learned from: a recent picture of it, quick to read. */
export const HISTORY_TARGET_USABLE_POSTS = 100;
/** Messages looked at, at most, to find them — forwards of polls, stickers and the like don't count. */
export const HISTORY_MAX_MESSAGES_SCANNED = 200;
/** Below this, recommendations may be less precise; onboarding carries on and says so. */
export const HISTORY_MIN_USEFUL_POSTS = 30;
/** Between t.me pages, so a crawl reads like a person scrolling, not a burst. */
export const HISTORY_PAGE_DELAY_MS = 300;
/** A rate limit this short is waited out in place; a longer one fails the crawl as transient, to be retried. */
export const HISTORY_MAX_WAIT_MS = 30_000;

/** Self-service channels one person may onboard. */
export const WORKSPACES_PER_USER = 3;
/** Tries of one step before the session fails. */
export const ONBOARDING_MAX_ATTEMPTS = 5;
/** How long a runner holds a step: longer than the step can take, so a crashed run is retried after. */
export const ONBOARDING_STEP_LEASE_MS = 15 * 60_000;
/** A new channel's digest: once a day, at this hour, in its owner's zone (§24). */
export const DIGEST_MINUTES_DEFAULT = 24 * 60;
export const DIGEST_HOUR_DEFAULT = 9;
