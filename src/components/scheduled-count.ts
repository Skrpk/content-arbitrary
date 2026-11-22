/**
 * Word that the number of scheduled posts has changed — a post scheduled in
 * the queue, or taken off the schedule — so the website's header counts again
 * without waiting for the next page.
 */
export const SCHEDULED_CHANGED_EVENT = 'zmistik:scheduled-changed';

export function announceScheduledChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SCHEDULED_CHANGED_EVENT));
}
