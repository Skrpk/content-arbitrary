/**
 * A time as a reviewer types it in reply to a draft, read in their zone.
 *
 *   18:30            today at 18:30, or tomorrow once that has passed
 *   tomorrow 9:00    завтра 9:00 · післязавтра 9:00 · today / сьогодні
 *   fri 18:00        the next Friday (today, if it is Friday and still before)
 *   21.11 18:30      that day this year, or next year once it has passed
 *   21.11.2026 18:30
 *
 * The day and the time come in either order, among any other words —
 * "publish it tomorrow at 9:00", "постав на пт 18:00" — which are passed
 * over. What is not read is a reply with no time in it, with two days in it,
 * or with a number that is neither: those are not guessed at.
 */

/** How far ahead a draft may be scheduled — as far as a post in review. */
export const DRAFT_SCHEDULE_MAX_DAYS_AHEAD = 365;

export type DraftTimeResult = { ok: true; at: Date } | { ok: false; reason: 'unreadable' | 'past' | 'too_far' };

const WEEKDAYS: Record<string, number> = {
  // Sunday is 0, as Date counts.
  sun: 0, sunday: 0, нд: 0, неділя: 0, неділю: 0,
  mon: 1, monday: 1, пн: 1, понеділок: 1,
  tue: 2, tuesday: 2, вт: 2, вівторок: 2,
  wed: 3, wednesday: 3, ср: 3, середа: 3, середу: 3,
  thu: 4, thursday: 4, чт: 4, четвер: 4,
  fri: 5, friday: 5, пт: 5, "п'ятниця": 5, "п'ятницю": 5, пятниця: 5, пятницю: 5,
  sat: 6, saturday: 6, сб: 6, субота: 6, суботу: 6,
};

const RELATIVE_DAYS: Record<string, number> = {
  today: 0, сьогодні: 0,
  tomorrow: 1, завтра: 1,
  післязавтра: 2,
};

const DATE = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{4}))?$/;

export function parseDraftTime(input: string, options: { now: Date; timeZone: string }): DraftTimeResult {
  const { now, timeZone } = options;
  const text = input
    .trim()
    .toLowerCase()
    .replace(/[’ʼ`]/g, "'");

  const clock = /(?:^|\s)(\d{1,2}):(\d{2})(?=[\s,.!?;]|$)/.exec(text);
  if (!clock) return { ok: false, reason: 'unreadable' };
  const hour = Number(clock[1]);
  const minute = Number(clock[2]);
  if (hour > 23 || minute > 59) return { ok: false, reason: 'unreadable' };

  const words = (text.slice(0, clock.index) + ' ' + text.slice(clock.index + clock[0].length))
    .split(/[\s,!?]+/)
    .map((word) => word.replace(/^[.:;]+|[.:;]+$/g, ''))
    .filter((word) => word !== '');
  // The day, if any: a word that names one, or a date. Other words are passed over,
  // but a number that is not a date might be a time misread, so it is not.
  const days = words.filter((word) => word in RELATIVE_DAYS || word in WEEKDAYS || DATE.test(word));
  if (days.length > 1 || words.some((word) => /\d/.test(word) && !DATE.test(word))) return { ok: false, reason: 'unreadable' };

  const today = wallDate(now, timeZone);
  const at = (date: WallDate) => wallTimeToUtc({ ...date, hour, minute }, timeZone);
  const word = days[0];

  let result: Date;
  if (word === undefined) {
    // A bare time is the next time the clock shows it.
    result = at(today);
    if (result.getTime() <= now.getTime()) result = at(addDays(today, 1));
  } else if (word in RELATIVE_DAYS) {
    result = at(addDays(today, RELATIVE_DAYS[word]!));
  } else if (word in WEEKDAYS) {
    const ahead = (WEEKDAYS[word]! - weekdayOf(today) + 7) % 7;
    result = at(addDays(today, ahead));
    if (result.getTime() <= now.getTime()) result = at(addDays(today, ahead + 7));
  } else {
    const date = DATE.exec(word);
    if (!date) return { ok: false, reason: 'unreadable' };
    const day = Number(date[1]);
    const month = Number(date[2]);
    const year = date[3] ? Number(date[3]) : today.year;
    if (!isRealDate(year, month, day)) return { ok: false, reason: 'unreadable' };
    result = at({ year, month, day });
    if (!date[3] && result.getTime() <= now.getTime() && isRealDate(year + 1, month, day)) {
      result = at({ year: year + 1, month, day });
    }
  }

  if (result.getTime() <= now.getTime()) return { ok: false, reason: 'past' };
  if (result.getTime() - now.getTime() > DRAFT_SCHEDULE_MAX_DAYS_AHEAD * 86_400_000) return { ok: false, reason: 'too_far' };
  return { ok: true, at: result };
}

interface WallDate {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function addDays(date: WallDate, days: number): WallDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

function weekdayOf(date: WallDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** What the clock on the wall shows at `at` in `timeZone`. */
function wallParts(at: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
  return parts;
}

function wallDate(at: Date, timeZone: string): WallDate {
  const { year, month, day } = wallParts(at, timeZone);
  return { year, month, day };
}

/** How far the zone's clock is ahead of UTC at `at`, in milliseconds. */
function offsetAt(at: number, timeZone: string): number {
  const parts = wallParts(new Date(at), timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** The moment the zone's clock shows this wall time; across a DST change, the offset after it. */
export function wallTimeToUtc(wall: WallDate & { hour: number; minute: number }, timeZone: string): Date {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const first = guess - offsetAt(guess, timeZone);
  const second = guess - offsetAt(first, timeZone);
  return new Date(second);
}
