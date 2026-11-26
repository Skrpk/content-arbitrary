import { describe, expect, it } from 'vitest';
import { buildDraftCallbackData, draftControl, messageLink, parseDraftCallbackData } from '@/lib/drafts/drafts';
import { parseDraftTime, wallTimeToUtc } from '@/lib/drafts/time';

const ZONE = 'Europe/Prague';
// Wednesday 18 November 2026, 14:00 in Prague (UTC+1).
const NOW = new Date('2026-11-18T13:00:00.000Z');
const read = (text: string, now = NOW) => parseDraftTime(text, { now, timeZone: ZONE });
const at = (text: string, now = NOW) => {
  const result = read(text, now);
  if (!result.ok) throw new Error(`"${text}" was not read: ${result.reason}`);
  return result.at.toISOString();
};

describe('parseDraftTime', () => {
  it('reads a bare time as the next time the clock shows it', () => {
    expect(at('18:30')).toBe('2026-11-18T17:30:00.000Z');
    // 9:00 has passed today: tomorrow.
    expect(at('9:00')).toBe('2026-11-19T08:00:00.000Z');
  });

  it('reads today, tomorrow and the day after, in English and Ukrainian', () => {
    expect(at('tomorrow 9:00')).toBe('2026-11-19T08:00:00.000Z');
    expect(at('завтра 9:00')).toBe('2026-11-19T08:00:00.000Z');
    expect(at('завтра о 9:00')).toBe('2026-11-19T08:00:00.000Z');
    expect(at('9:00 завтра')).toBe('2026-11-19T08:00:00.000Z');
    expect(at('післязавтра 10:15')).toBe('2026-11-20T09:15:00.000Z');
    expect(at('сьогодні 20:00')).toBe('2026-11-18T19:00:00.000Z');
    expect(at('Tomorrow at 9:00')).toBe('2026-11-19T08:00:00.000Z');
  });

  it('reads a weekday as the next one', () => {
    expect(at('fri 18:00')).toBe('2026-11-20T17:00:00.000Z');
    expect(at("п'ятниця 18:00")).toBe('2026-11-20T17:00:00.000Z');
    expect(at('пʼятницю 18:00')).toBe('2026-11-20T17:00:00.000Z');
    // Today is Wednesday: later today is today, earlier is next week.
    expect(at('ср 20:00')).toBe('2026-11-18T19:00:00.000Z');
    expect(at('wed 8:00')).toBe('2026-11-25T07:00:00.000Z');
  });

  it('reads a date, this year or next once it has passed', () => {
    expect(at('21.11 18:30')).toBe('2026-11-21T17:30:00.000Z');
    expect(at('21/11 18:30')).toBe('2026-11-21T17:30:00.000Z');
    expect(at('2.01 10:00')).toBe('2027-01-02T09:00:00.000Z');
    expect(at('21.11.2026 18:30')).toBe('2026-11-21T17:30:00.000Z');
    // Summer time: UTC+2.
    expect(at('15.07 12:00')).toBe('2027-07-15T10:00:00.000Z');
  });

  it('passes over other words around the day and the time', () => {
    expect(at('sent it tomorrow at 8:00')).toBe('2026-11-19T07:00:00.000Z');
    expect(at('постав на пт 18:00, дякую!')).toBe('2026-11-20T17:00:00.000Z');
    expect(at('завтра вранці 9:00')).toBe('2026-11-19T08:00:00.000Z');
    expect(at('publish it 9:00')).toBe('2026-11-19T08:00:00.000Z');
    expect(at('on 21.11 at 18:30.')).toBe('2026-11-21T17:30:00.000Z');
  });

  it('refuses what is not a time', () => {
    for (const text of ['', 'soon', '18', 'tomorrow at 8', '25:00', '18:61', '31.02 10:00', 'tomorrow fri 9:00', 'in 2 hours 9:00', '9:00 or 10:00']) {
      expect(read(text)).toEqual({ ok: false, reason: 'unreadable' });
    }
  });

  it('refuses a time that has passed or is too far ahead', () => {
    expect(read('сьогодні 10:00')).toEqual({ ok: false, reason: 'past' });
    expect(read('1.01.2026 10:00')).toEqual({ ok: false, reason: 'past' });
    expect(read('1.01.2028 10:00')).toEqual({ ok: false, reason: 'too_far' });
  });

  it('turns a wall time into the moment, across a summer-time change', () => {
    // The last Sunday of March 2027: 3:00 in Prague is already UTC+2.
    expect(wallTimeToUtc({ year: 2027, month: 3, day: 28, hour: 1, minute: 30 }, ZONE).toISOString()).toBe('2027-03-28T00:30:00.000Z');
    expect(wallTimeToUtc({ year: 2027, month: 3, day: 28, hour: 4, minute: 0 }, ZONE).toISOString()).toBe('2027-03-28T02:00:00.000Z');
    expect(wallTimeToUtc({ year: 2026, month: 11, day: 18, hour: 9, minute: 0 }, 'UTC').toISOString()).toBe('2026-11-18T09:00:00.000Z');
  });
});

describe('draft buttons', () => {
  it('round-trips every action and refuses the rest', () => {
    for (const action of ['publish', 'schedule_hint', 'unschedule', 'reject', 'restore'] as const) {
      expect(parseDraftCallbackData(buildDraftCallbackData(action, 42))).toEqual({ action, draftId: 42 });
    }
    expect(parseDraftCallbackData('dn:0')).toBeNull();
    expect(parseDraftCallbackData('ap:42')).toBeNull();
    expect(parseDraftCallbackData('dn:42:x')).toBeNull();
    expect(parseDraftCallbackData(undefined)).toBeNull();
  });

  it('links a message of a channel', () => {
    expect(messageLink('-1004457604656', 17)).toBe('https://t.me/c/4457604656/17');
    expect(messageLink('12345', 17)).toBeNull();
  });
});

describe('draftControl', () => {
  const base = {
    id: 7,
    status: 'waiting' as const,
    scheduledFor: null,
    scheduledTimezone: ZONE,
    editedAt: null,
    error: null,
    publishedChatId: null,
    publishedMessageIds: null,
    publishedAt: null,
  };
  const context = { channel: 'Vector', sourceUrl: 'https://x.com/a/status/1' };
  const callbacks = (keyboard: { inline_keyboard: unknown[][] }) =>
    keyboard.inline_keyboard.flat().map((button) => (button as { callback_data?: string; url?: string }).callback_data ?? (button as { url?: string }).url);

  it('offers Publish now, Schedule and Reject while waiting, and says how to type a time', () => {
    const control = draftControl(base, context);
    expect(control.text).toContain('📝 Draft for <b>Vector</b>');
    expect(control.text).toContain('tomorrow 9:00');
    expect(callbacks(control.keyboard)).toEqual(['dn:7', 'dt:7', 'dr:7']);
  });

  it('shows the time once scheduled, in the reviewer’s zone, and that the post was edited', () => {
    const control = draftControl(
      { ...base, status: 'scheduled', scheduledFor: new Date('2026-11-19T08:00:00.000Z'), editedAt: new Date() },
      context,
    );
    expect(control.text).toContain('🕒 Scheduled for Thu 19 Nov, 09:00 → <b>Vector</b>');
    expect(control.text).toContain('✏️ Edited here');
    expect(callbacks(control.keyboard)).toEqual(['dn:7', 'du:7', 'dr:7']);
  });

  it('keeps saying where it went once published, with a link to it', () => {
    const control = draftControl(
      { ...base, status: 'published', publishedChatId: '-1002000000002', publishedMessageIds: [55], publishedAt: new Date('2026-11-19T08:00:00.000Z') },
      context,
    );
    expect(control.text).toContain('✅ Published to <b>Vector</b> · Thu 19 Nov, 09:00');
    expect(callbacks(control.keyboard)).toEqual(['https://t.me/c/2000000002/55']);
  });

  it('can be restored once rejected', () => {
    const control = draftControl({ ...base, status: 'rejected' }, context);
    expect(control.text).toContain('🗑 Rejected');
    expect(callbacks(control.keyboard)).toEqual(['dx:7']);
  });
});
