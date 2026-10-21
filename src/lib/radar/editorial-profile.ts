/**
 * The editorial profile as the reviewer edits it on the settings page: the
 * channel's policy in their own words, the one part of Radar's prompt that is
 * theirs to write (src/lib/radar/prompt.ts carries it in `<editorial_profile>`).
 * The rest of the prompt stays fixed per prompt version, so scores remain
 * comparable. Kept free of server-only imports: the settings page reads it too.
 */

/** The longest profile, in characters — as Postgres counts them, which is what the column's check does. */
export const EDITORIAL_PROFILE_MAX_LENGTH = 2000;

/** Its length as that check counts it: code points, so an emoji is one, not two. */
export function editorialProfileLength(text: string): number {
  return Array.from(text).length;
}

/** What is stored for what was typed: trimmed, and nothing at all — Radar off — for a blank one. */
export function normaliseEditorialProfile(text: string | null): string | null {
  const trimmed = text?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}
