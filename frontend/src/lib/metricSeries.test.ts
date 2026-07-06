import { describe, expect, it } from 'vitest';
import { DAY_MS, alignGhost, baselineCoveredByPosts, bucketKeyOf, bucketKeysInWindow, comparisonWindow, movingAverageGhost, sameWeekdayGhost, weekdayOfKey } from './metricSeries';

describe('baselineCoveredByPosts — suppress an undercounted comparison', () => {
  it('true when the oldest loaded post is at/before the baseline start', () => {
    expect(baselineCoveredByPosts([100, 200, 300], 150)).toBe(true); // oldest 100 <= 150
    expect(baselineCoveredByPosts([100], 100)).toBe(true); // equal = covered
  });
  it('false when the baseline predates the oldest loaded post (undercount risk → the +969% bug)', () => {
    expect(baselineCoveredByPosts([200, 300, 400], 150)).toBe(false); // oldest 200 > 150
  });
  it('false for empty / all-undated posts (cannot prove coverage)', () => {
    expect(baselineCoveredByPosts([], 150)).toBe(false);
    expect(baselineCoveredByPosts([NaN, NaN], 150)).toBe(false);
  });
  it('ignores undated posts (NaN) when finding the oldest', () => {
    expect(baselineCoveredByPosts([NaN, 100, NaN], 150)).toBe(true);
    expect(baselineCoveredByPosts([NaN, 200, NaN], 150)).toBe(false);
  });
  it('capped=false → always covered (all posts loaded, so the sum is complete even if sparse)', () => {
    // Would be false under the default capped check (oldest 200 > baseFrom 150), but a non-capped
    // fetch means we have every post → no undercount → never over-suppress a small/new channel.
    expect(baselineCoveredByPosts([200, 300], 150, false)).toBe(true);
    expect(baselineCoveredByPosts([], 150, false)).toBe(true);
  });
  it('capped=true (explicit) matches the default oldest-reaches-baseline check', () => {
    expect(baselineCoveredByPosts([200, 300], 150, true)).toBe(false);
    expect(baselineCoveredByPosts([100, 300], 150, true)).toBe(true);
  });
});

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

describe('bucketKeyOf — quarter / year (S10)', () => {
  const at = (iso: string) => Date.parse(`${iso}T12:00:00Z`);
  it('maps an instant to its quarter key', () => {
    expect(bucketKeyOf(at('2026-01-15'), 'quarter')).toBe('2026-Q1');
    expect(bucketKeyOf(at('2026-03-31'), 'quarter')).toBe('2026-Q1');
    expect(bucketKeyOf(at('2026-04-01'), 'quarter')).toBe('2026-Q2');
    expect(bucketKeyOf(at('2026-09-30'), 'quarter')).toBe('2026-Q3');
    expect(bucketKeyOf(at('2026-12-31'), 'quarter')).toBe('2026-Q4');
  });
  it('maps an instant to its year key', () => {
    expect(bucketKeyOf(at('2026-06-15'), 'year')).toBe('2026');
    expect(bucketKeyOf(at('2025-01-01'), 'year')).toBe('2025');
  });
});

describe('bucketKeysInWindow — quarter / year (S10)', () => {
  const at = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
  it('covers every quarter in the window, in order, once', () => {
    expect(bucketKeysInWindow(at('2025-11-01'), at('2026-05-01'), 'quarter')).toEqual([
      '2025-Q4',
      '2026-Q1',
      '2026-Q2',
    ]);
  });
  it('covers every year in the window, in order, once', () => {
    expect(bucketKeysInWindow(at('2024-06-01'), at('2026-03-01'), 'year')).toEqual(['2024', '2025', '2026']);
  });
  it('a sub-quarter window yields exactly one quarter bucket', () => {
    expect(bucketKeysInWindow(at('2026-05-17'), at('2026-06-15'), 'quarter')).toEqual(['2026-Q2']);
  });
  it('the ghost baseline matches the active length at quarter grain (no off-by-one)', () => {
    const winTo = Date.parse('2026-06-15T14:30:00Z');
    const winFrom = winTo - 179 * DAY_MS; // ~6 months → 2-3 quarter buckets
    const active = bucketKeysInWindow(winFrom, winTo, 'quarter');
    const base = comparisonWindow(winFrom, winTo, 'prev');
    const baseKeys = bucketKeysInWindow(base.from, base.to, 'quarter');
    // alignGhost tolerates a ±1 calendar-bucket drift; assert it aligns cleanly.
    expect(alignGhost(baseKeys.map((_, i) => i), active.length).length).toBe(active.length);
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

describe('weekdayOfKey', () => {
  it('returns a UTC weekday for a plain YYYY-MM-DD key', () => {
    const wd = weekdayOfKey('2026-07-06');
    expect(wd).not.toBeNull();
    expect(wd).toBeGreaterThanOrEqual(0);
    expect(wd).toBeLessThanOrEqual(6);
    // dates exactly 7 days apart share a weekday (grain-agnostic invariant the ghost relies on)
    expect(weekdayOfKey('2026-01-01')).toBe(weekdayOfKey('2026-01-08'));
    // …and adjacent days differ
    expect(weekdayOfKey('2026-01-01')).not.toBe(weekdayOfKey('2026-01-02'));
  });
  it('null for non-day keys (month/quarter/year buckets) and garbage', () => {
    expect(weekdayOfKey('2026-01')).toBeNull();
    expect(weekdayOfKey('2026')).toBeNull();
    expect(weekdayOfKey('2026-Q1')).toBeNull();
    expect(weekdayOfKey('nope')).toBeNull();
  });
});

describe('movingAverageGhost — self-referential trailing mean', () => {
  it('averages the trailing window up to each point (inclusive)', () => {
    expect(movingAverageGhost([2, 4, 6, 8], 2)).toEqual([2, 3, 5, 7]);
  });
  it('window 1 is the identity; a wide window is the running cumulative mean', () => {
    expect(movingAverageGhost([3, 5, 7], 1)).toEqual([3, 5, 7]);
    expect(movingAverageGhost([2, 4, 6], 10)).toEqual([2, 3, 4]);
  });
  it('skips non-finite values in the mean and never divides by zero', () => {
    expect(movingAverageGhost([2, NaN, 4], 3)).toEqual([2, 2, 3]);
    expect(movingAverageGhost([], 7)).toEqual([]);
  });
});

describe('sameWeekdayGhost — per-weekday typical value', () => {
  it('replaces each point with the mean of its own weekday in the window', () => {
    // 01-01 & 01-08 share a weekday; 01-02 & 01-09 share the next → two groups
    const dates = ['2026-01-01', '2026-01-02', '2026-01-08', '2026-01-09'];
    const values = [10, 20, 30, 40];
    expect(sameWeekdayGhost(dates, values)).toEqual([20, 30, 20, 30]);
  });
  it('null when a single weekday only (weekly buckets — «same weekday» is moot)', () => {
    // all 7 days apart → one weekday
    expect(sameWeekdayGhost(['2026-01-01', '2026-01-08', '2026-01-15'], [1, 2, 3])).toBeNull();
  });
  it('null for non-day keys (month grain) and length mismatch / empty', () => {
    expect(sameWeekdayGhost(['2026-01', '2026-02'], [1, 2])).toBeNull();
    expect(sameWeekdayGhost(['2026-01-01'], [1, 2])).toBeNull();
    expect(sameWeekdayGhost([], [])).toBeNull();
  });
});
