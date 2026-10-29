import { describe, expect, it } from 'vitest';
import { belowThresholdReason, RADAR_THRESHOLD_REASON_PREFIX } from '@/lib/radar/threshold';

describe('belowThresholdReason', () => {
  it('passes over a post scored under the threshold, and says by how much', () => {
    expect(belowThresholdReason(39, 40)).toBe(`${RADAR_THRESHOLD_REASON_PREFIX}scored 39, under the source's 40`);
  });

  it('sends on a post at or over the threshold', () => {
    expect(belowThresholdReason(40, 40)).toBeNull();
    expect(belowThresholdReason(95, 40)).toBeNull();
  });

  it('sends on every post of a source with no threshold, and a post with no score', () => {
    expect(belowThresholdReason(1, null)).toBeNull();
    expect(belowThresholdReason(null, 40)).toBeNull();
    expect(belowThresholdReason(undefined, 40)).toBeNull();
  });
});
