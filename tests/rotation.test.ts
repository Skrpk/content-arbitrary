import { describe, expect, it } from 'vitest';
import { lastSyncKey, longestWaitingFirst, tenantWaitedSince } from '@/lib/sync/rotation';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 6, 10, minute));

describe('longestWaitingFirst', () => {
  it('puts never-synced first, then the least recently synced, keeping order among equals', () => {
    const synced = new Map([
      ['a', at(30)],
      ['b', at(10)],
      ['d', at(10)],
    ]);
    expect(longestWaitingFirst(['a', 'b', 'c', 'd', 'e'], (item) => synced.get(item))).toEqual([
      'c',
      'e',
      'b',
      'd',
      'a',
    ]);
  });
});

describe('tenantWaitedSince', () => {
  const times = new Map([
    [lastSyncKey(1, 'x:1'), at(10)],
    [lastSyncKey(1, 'x:2'), at(40)],
    [lastSyncKey(1, 'x:removed'), at(0)],
    [lastSyncKey(2, 'x:1'), at(5)],
  ]);

  it("is its longest-waiting enabled source's last sync", () => {
    expect(tenantWaitedSince(times, 1, ['x:1', 'x:2'])).toEqual(at(10));
  });

  it("ignores a removed source's leftover cursor, and other tenants' sources", () => {
    // x:removed (minute 0) is not enabled; tenant 2's x:1 (minute 5) is not this tenant's.
    expect(tenantWaitedSince(times, 1, ['x:2'])).toEqual(at(40));
  });

  it('puts a tenant with a never-synced source first', () => {
    expect(tenantWaitedSince(times, 1, ['x:1', 'x:new'])).toBeUndefined();
  });
});
