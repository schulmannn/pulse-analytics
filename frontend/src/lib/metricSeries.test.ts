import { describe, expect, it } from 'vitest';
import { DAY_MS, alignGhost, bucketKeysInWindow, comparisonWindow } from './metricSeries';

describe('comparisonWindow — day-bucket count invariant', () => {
  // Non-midnight winTo (like Date.now()) is exactly what once broke the ghost: the baseline
  // day-bucket count must equal the active window's, or the strict length gate drops it.
  const days = 30;
  const winTo = 1_751_557_800_000; // 2025-07-03T14:30:00Z — deliberately NOT a midnight
  const winFrom = winTo - (days - 1) * DAY_MS;

  it('previous period spans the same number of day buckets as the active window', () => {
    const active = bucketKeysInWindow(winFrom, winTo, 'day');
    const base = comparisonWindow(winFrom, winTo, 'prev');
    const baseKeys = bucketKeysInWindow(base.from, base.to, 'day');
    expect(active.length).toBe(days);
    expect(baseKeys.length).toBe(active.length); // the bug: was 31 vs 30
  });

  it('previous window does not overlap the active window', () => {
    const active = bucketKeysInWindow(winFrom, winTo, 'day');
    const base = comparisonWindow(winFrom, winTo, 'prev');
    const baseKeys = bucketKeysInWindow(base.from, base.to, 'day');
    expect(baseKeys[baseKeys.length - 1] < active[0]).toBe(true);
  });

  it('the OLD `to: winFrom - 1ms` boundary is what overshot by a day (regression witness)', () => {
    const active = bucketKeysInWindow(winFrom, winTo, 'day');
    const overshoot = bucketKeysInWindow(winFrom - (days - 1) * DAY_MS - DAY_MS, winFrom - 1, 'day');
    expect(overshoot.length).toBe(active.length + 1);
  });

  it('year-over-year window also matches the active length', () => {
    const active = bucketKeysInWindow(winFrom, winTo, 'day');
    const base = comparisonWindow(winFrom, winTo, 'year');
    expect(bucketKeysInWindow(base.from, base.to, 'day').length).toBe(active.length);
  });
});

describe('alignGhost', () => {
  it('returns the series unchanged when lengths match', () => {
    expect(alignGhost([1, 2, 3], 3)).toEqual([1, 2, 3]);
  });
  it('drops the tail overshoot (keeps leading buckets)', () => {
    expect(alignGhost([1, 2, 3, 4], 3)).toEqual([1, 2, 3]);
  });
  it('front-pads with zeros when short', () => {
    expect(alignGhost([5, 6], 4)).toEqual([0, 0, 5, 6]);
  });
});
