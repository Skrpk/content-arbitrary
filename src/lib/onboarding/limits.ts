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
