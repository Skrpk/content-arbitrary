import { describe, expect, it } from 'vitest';
import { buildReviewQueueUrl, formatReviewDigest, reviewDigestIsDue } from '@/lib/review/queue';
import { usesReviewQueue } from '@/lib/workspace';

const at = (iso: string) => new Date(iso);

describe('when a queue notification is due', () => {
  const hourly = { reviewDigestMinutes: 60, reviewDigestSentAt: at('2026-10-09T10:00:07Z') };

  it('is due at once before the first one', () => {
    expect(reviewDigestIsDue({ reviewDigestMinutes: 60, reviewDigestSentAt: null }, at('2026-10-09T10:00:00Z'))).toBe(true);
  });

  it('waits out the interval, give or take a cron run starting a few seconds early', () => {
    expect(reviewDigestIsDue(hourly, at('2026-10-09T10:45:00Z'))).toBe(false);
    expect(reviewDigestIsDue(hourly, at('2026-10-09T11:00:02Z'))).toBe(true);
  });

  it('is never due for a channel whose posts go to the chat', () => {
    expect(reviewDigestIsDue({ reviewDigestMinutes: null, reviewDigestSentAt: null }, at('2026-10-09T10:00:00Z'))).toBe(false);
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
