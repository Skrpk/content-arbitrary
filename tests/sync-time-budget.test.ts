import { describe, expect, it } from 'vitest';
import { maxDuration } from '@/app/api/cron/sync/route';
import { SYNC_TIME_BUDGET_MS } from '@/lib/sync/sync-posts';
import { TELEGRAM_REQUEST_TIMEOUT_MS } from '@/lib/telegram/client';
import { MEDIA_DOWNLOAD_TIMEOUT_MS } from '@/lib/x/download-media';

describe('the sync time budget', () => {
  it('leaves room inside maxDuration for the post under way when it runs out', () => {
    // A post started just before the budget ends may still download (up to
    // the media timeout) and send (up to the Telegram timeout).
    expect(SYNC_TIME_BUDGET_MS + MEDIA_DOWNLOAD_TIMEOUT_MS + TELEGRAM_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(
      maxDuration * 1000,
    );
  });
});

describe("Radar's share of the run", () => {
  it('never reaches past the sync deadline, however much of its own budget is left', async () => {
    const { createRadarRun } = await import('@/lib/radar/shadow');
    const { fakeOpenAi } = await import('./radar-fakes');
    const { provider } = fakeOpenAi(() => new Response('{}'));

    expect(createRadarRun({ provider, now: () => 1_000, budgetMs: 120_000, notAfter: 30_000 }).deadline).toBe(30_000);
    expect(createRadarRun({ provider, now: () => 1_000, budgetMs: 120_000, notAfter: 900_000 }).deadline).toBe(121_000);
  });
});
