import { describe, expect, it } from 'vitest';
import {
  buildReviewQueueUrl,
  formatReviewDigest,
  nextDigestAt,
  reviewDigestIsDue,
  reviewQueueButton,
} from '@/lib/review/queue';
import { usesReviewQueue } from '@/lib/workspace';

const at = (iso: string) => new Date(iso);

describe('when a queue notification is due', () => {
  const anyHour = { reviewDigestHour: null, reviewDigestTimezone: null };
  const hourly = { ...anyHour, reviewDigestMinutes: 60, reviewDigestSentAt: at('2026-10-09T10:00:07Z') };

  it('is due at once before the first one', () => {
    expect(reviewDigestIsDue({ ...anyHour, reviewDigestMinutes: 60, reviewDigestSentAt: null }, at('2026-10-09T10:00:00Z'))).toBe(true);
  });

  it('waits out the interval, give or take a cron run starting a few seconds early', () => {
    expect(reviewDigestIsDue(hourly, at('2026-10-09T10:45:00Z'))).toBe(false);
    expect(reviewDigestIsDue(hourly, at('2026-10-09T11:00:02Z'))).toBe(true);
  });

  it('is never due for a channel whose posts go to the chat', () => {
    expect(reviewDigestIsDue({ ...anyHour, reviewDigestMinutes: null, reviewDigestSentAt: null }, at('2026-10-09T10:00:00Z'))).toBe(false);
  });
});

describe('a daily notification at a chosen hour', () => {
  const kyiv = { reviewDigestHour: 20, reviewDigestTimezone: 'Europe/Kyiv' };
  const daily = { ...kyiv, reviewDigestMinutes: 24 * 60 };

  it('waits for the hour, even before the first one', () => {
    // 20:00 in Kyiv is 17:00 UTC in October (EEST, UTC+3).
    expect(reviewDigestIsDue({ ...daily, reviewDigestSentAt: null }, at('2026-10-09T16:30:00Z'))).toBe(false);
    expect(reviewDigestIsDue({ ...daily, reviewDigestSentAt: null }, at('2026-10-09T17:00:05Z'))).toBe(true);
  });

  it('comes the next evening, not a day after a late one', () => {
    const sent = at('2026-10-09T17:14:00Z'); // 20:14, a cron run late
    expect(nextDigestAt(sent, 24 * 60, 20, 'Europe/Kyiv')).toEqual(at('2026-10-10T17:00:00Z'));
    expect(reviewDigestIsDue({ ...daily, reviewDigestSentAt: sent }, at('2026-10-10T16:45:00Z'))).toBe(false);
    expect(reviewDigestIsDue({ ...daily, reviewDigestSentAt: sent }, at('2026-10-10T16:58:00Z'))).toBe(true);
  });

  it('keeps to 20:00 local when the clocks go back', () => {
    // Kyiv leaves summer time on 25 October 2026: 20:00 is then 18:00 UTC.
    expect(nextDigestAt(at('2026-10-24T17:00:00Z'), 24 * 60, 20, 'Europe/Kyiv')).toEqual(at('2026-10-25T18:00:00Z'));
  });

  it('moves when the hour is changed', () => {
    const sent = at('2026-10-09T17:00:00Z'); // 20:00 yesterday evening
    expect(nextDigestAt(sent, 24 * 60, 9, 'Europe/Kyiv')).toEqual(at('2026-10-10T06:00:00Z'));
  });

  it('keeps to the hour every few days and every week', () => {
    expect(nextDigestAt(at('2026-10-09T17:02:00Z'), 7 * 24 * 60, 20, 'Europe/Kyiv')).toEqual(at('2026-10-16T17:00:00Z'));
    expect(nextDigestAt(at('2026-10-09T17:02:00Z'), 3 * 24 * 60, 20, 'Europe/Kyiv')).toEqual(at('2026-10-12T17:00:00Z'));
  });

  it('is ignored for intervals shorter than a day', () => {
    const hourly = { ...kyiv, reviewDigestMinutes: 60, reviewDigestSentAt: at('2026-10-09T10:00:00Z') };
    expect(reviewDigestIsDue(hourly, at('2026-10-09T11:00:00Z'))).toBe(true);
  });
});

describe('the queue notification', () => {
  it('counts the new posts, and the rest waiting when there are more', () => {
    expect(formatReviewDigest({ fresh: 1, waiting: 1 })).toBe('📥 <b>1 post</b> new for review\nBest Radar score first.');
    expect(formatReviewDigest({ fresh: 3, waiting: 12, channel: 'A & B' })).toBe(
      '📢 A &amp; B\n📥 <b>3 posts</b> new for review · 12 waiting in all\nBest Radar score first.',
    );
  });

  it('links to the queue page on its channel', () => {
    expect(buildReviewQueueUrl('https://example.vercel.app/', 2)).toBe('https://example.vercel.app/queue?workspace=2');
    expect(buildReviewQueueUrl('https://example.vercel.app')).toBe('https://example.vercel.app/queue');
  });
});

describe('whether a channel uses the review queue', () => {
  const env = { REQUIRE_APPROVAL: true, APP_BASE_URL: 'https://example.vercel.app' };

  it('needs review, an interval, and the Mini App the queue is a page of', () => {
    expect(usesReviewQueue({ reviewDigestMinutes: 60 }, env)).toBe(true);
    expect(usesReviewQueue({ reviewDigestMinutes: null }, env)).toBe(false);
    expect(usesReviewQueue({ reviewDigestMinutes: 60 }, { ...env, APP_BASE_URL: undefined })).toBe(false);
    expect(usesReviewQueue({ reviewDigestMinutes: 60 }, { ...env, REQUIRE_APPROVAL: false })).toBe(false);
  });
});

describe('the "Open review queue" button', () => {
  const urls = { appBaseUrl: 'https://mini.example.com', webAppUrl: 'https://app.example.com' };

  it('opens the website in the browser for someone who reviews there', () => {
    expect(reviewQueueButton({ ...urls, target: 'website', workspaceId: 2 })).toEqual({
      text: '📋 Open review queue',
      url: 'https://app.example.com/queue?workspace=2',
    });
  });

  it('opens the Mini App otherwise — and when there is no website to open', () => {
    expect(reviewQueueButton({ ...urls, target: 'mini_app', workspaceId: 2 })).toEqual({
      text: '📋 Open review queue',
      web_app: { url: 'https://mini.example.com/queue?workspace=2' },
    });
    expect(reviewQueueButton({ ...urls, webAppUrl: undefined, target: 'website' })).toMatchObject({
      web_app: { url: 'https://mini.example.com/queue' },
    });
    expect(reviewQueueButton({ appBaseUrl: undefined, webAppUrl: undefined, target: 'mini_app' })).toBeNull();
  });
});
