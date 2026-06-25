import { afterEach, describe, expect, it, vi } from 'vitest';
import { inRangeByDays, tgLimit } from '@/lib/period';

describe('tgLimit', () => {
  it.each([
    [7, 30],
    [30, 60],
    [90, 100],
    [365, 100],
    [0, 100],
  ] as const)('maps %s days to limit %s', (days, expected) => {
    expect(tgLimit(days)).toBe(expected);
  });
});

describe('inRangeByDays', () => {
  afterEach(() => vi.useRealTimers());

  it('accepts every value for the all-time period', () => {
    expect(inRangeByDays(null, 0)).toBe(true);
    expect(inRangeByDays('not-a-date', 0)).toBe(true);
  });

  it('rejects missing and invalid dates for bounded periods', () => {
    expect(inRangeByDays(null, 30)).toBe(false);
    expect(inRangeByDays(undefined, 30)).toBe(false);
    expect(inRangeByDays('not-a-date', 30)).toBe(false);
  });

  it('includes the exact lower boundary and rejects an older instant', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-25T12:00:00.000Z'));
    expect(inRangeByDays('2026-05-26T12:00:00.000Z', 30)).toBe(true);
    expect(inRangeByDays('2026-05-26T11:59:59.999Z', 30)).toBe(false);
    expect(inRangeByDays('2026-06-25T12:00:00.000Z', 30)).toBe(true);
  });
});
