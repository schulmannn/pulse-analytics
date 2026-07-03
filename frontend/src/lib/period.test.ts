import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasDataWithin, inRangeByDays, recommendPeriod, resolveEffectivePeriod, tgLimit } from '@/lib/period';

const DAY = 86_400_000;
const NOW = Date.parse('2026-07-03T12:00:00.000Z');
const ago = (days: number) => NOW - days * DAY;

describe('tgLimit', () => {
  it.each([
    [7, 30],
    [30, 60],
    [90, 100],
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

describe('hasDataWithin', () => {
  it('is false when recency is unknown (bounded and all-time)', () => {
    expect(hasDataWithin(null, 30, NOW)).toBe(false);
    expect(hasDataWithin(null, 0, NOW)).toBe(false);
  });
  it('treats «Всё» as always in range given any data', () => {
    expect(hasDataWithin(ago(999), 0, NOW)).toBe(true);
  });
  it('accepts data inside the window and rejects older', () => {
    expect(hasDataWithin(ago(3), 7, NOW)).toBe(true);
    expect(hasDataWithin(ago(10), 7, NOW)).toBe(false);
    expect(hasDataWithin(ago(10), 30, NOW)).toBe(true);
  });
});

describe('recommendPeriod', () => {
  it('falls back to the default when recency is unknown', () => {
    expect(recommendPeriod(null, NOW)).toBe(30);
  });
  it('picks the smallest preset covering the newest data', () => {
    expect(recommendPeriod(ago(2), NOW)).toBe(7);
    expect(recommendPeriod(ago(20), NOW)).toBe(30);
    expect(recommendPeriod(ago(80), NOW)).toBe(90);
  });
  it('returns «Всё» (0) once the newest data is older than 90д (the dormant-channel case)', () => {
    expect(recommendPeriod(ago(95), NOW)).toBe(0);
  });
});

describe('resolveEffectivePeriod', () => {
  it('is a no-op when recency is unknown (outside the feed)', () => {
    expect(resolveEffectivePeriod(7, null, NOW)).toBe(7);
  });
  it('keeps the requested window when it holds data', () => {
    expect(resolveEffectivePeriod(7, ago(3), NOW)).toBe(7);
    expect(resolveEffectivePeriod(0, ago(999), NOW)).toBe(0);
  });
  it('widens an empty window to the smallest one with data', () => {
    // requested 7д, newest post 20д old → widen to 30д
    expect(resolveEffectivePeriod(7, ago(20), NOW)).toBe(30);
  });
  it('widens to «Всё» for a dormant channel (all data >90д old)', () => {
    // tydaaya case: pref 7д / 90д, newest post ~95д old → «Всё»
    expect(resolveEffectivePeriod(7, ago(95), NOW)).toBe(0);
    expect(resolveEffectivePeriod(90, ago(95), NOW)).toBe(0);
  });
});
