import { describe, expect, it, vi } from 'vitest';
import { computeBackoffMs, withRetry } from '@/lib/sync/retry';
import { AppError, isTransient, MediaUnsupportedError } from '@/lib/errors';
import { instantSleep } from './helpers';

const transient = (message = 'boom') =>
  new AppError(message, { transient: true, code: 'test_transient' });
const permanent = (message = 'nope') =>
  new AppError(message, { transient: false, code: 'test_permanent' });

describe('isTransient', () => {
  it('honours the flag on AppError', () => {
    expect(isTransient(transient())).toBe(true);
    expect(isTransient(permanent())).toBe(false);
  });

  it('treats a MediaUnsupportedError as permanent', () => {
    expect(isTransient(new MediaUnsupportedError('too big'))).toBe(false);
  });

  it('treats an undici network failure as transient', () => {
    expect(isTransient(new TypeError('fetch failed'))).toBe(true);
  });

  it('treats a reset socket as transient', () => {
    expect(isTransient(new Error('read ECONNRESET'))).toBe(true);
  });

  it('does not retry an unknown plain error', () => {
    expect(isTransient(new Error('something odd'))).toBe(false);
  });
});

describe('computeBackoffMs', () => {
  it('grows exponentially across attempts', () => {
    const fixed = () => 1; // remove jitter
    const first = computeBackoffMs(1, 500, 30_000, fixed);
    const second = computeBackoffMs(2, 500, 30_000, fixed);
    const third = computeBackoffMs(3, 500, 30_000, fixed);

    expect(first).toBe(500);
    expect(second).toBe(1000);
    expect(third).toBe(2000);
  });

  it('never exceeds the ceiling', () => {
    expect(computeBackoffMs(20, 500, 30_000, () => 1)).toBe(30_000);
  });

  it('applies jitter so parallel retries do not collide', () => {
    const low = computeBackoffMs(3, 500, 30_000, () => 0);
    const high = computeBackoffMs(3, 500, 30_000, () => 1);
    expect(low).toBeLessThan(high);
    expect(low).toBeGreaterThan(0);
  });
});

describe('withRetry', () => {
  it('returns the value on first success without sleeping', async () => {
    const sleep = vi.fn(instantSleep);
    const operation = vi.fn().mockResolvedValue('ok');

    await expect(withRetry(operation, { attempts: 5, sleep })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a transient failure and then succeeds', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient())
      .mockResolvedValue('recovered');

    await expect(withRetry(operation, { attempts: 5, sleep: instantSleep })).resolves.toBe(
      'recovered',
    );
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('gives up immediately on a permanent failure', async () => {
    const operation = vi.fn().mockRejectedValue(permanent());

    await expect(withRetry(operation, { attempts: 5, sleep: instantSleep })).rejects.toThrow('nope');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('stops after exactly `attempts` tries', async () => {
    const operation = vi.fn().mockRejectedValue(transient());

    await expect(withRetry(operation, { attempts: 5, sleep: instantSleep })).rejects.toThrow('boom');
    expect(operation).toHaveBeenCalledTimes(5);
  });

  it('honours an explicit retryAfterMs instead of its own backoff', async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };

    const operation = vi
      .fn()
      .mockRejectedValueOnce(
        new AppError('flood', { transient: true, code: 'rate', retryAfterMs: 7000 }),
      )
      .mockResolvedValue('done');

    await withRetry(operation, { attempts: 3, sleep });
    expect(delays).toEqual([7000]);
  });

  it('refuses to wait longer than maxRetryAfterMs', async () => {
    const sleep = vi.fn(instantSleep);
    const operation = vi
      .fn()
      .mockRejectedValue(
        new AppError('long flood', { transient: true, code: 'rate', retryAfterMs: 600_000 }),
      );

    await expect(
      withRetry(operation, { attempts: 5, sleep, maxRetryAfterMs: 60_000 }),
    ).rejects.toThrow('long flood');

    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
