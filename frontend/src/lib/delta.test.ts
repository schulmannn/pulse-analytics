import { describe, expect, it } from 'vitest';
import { pctDelta, subscriberDelta, sumPostWindows } from '@/lib/delta';

describe('pctDelta', () => {
  it('returns direction and absolute percentage', () => {
    expect(pctDelta(120, 100)).toEqual({ pct: 20, dir: 'up' });
    expect(pctDelta(75, 100)).toEqual({ pct: 25, dir: 'down' });
    expect(pctDelta(100, 100)).toEqual({ pct: 0, dir: 'flat' });
  });

  it('rejects a missing, zero or invalid baseline', () => {
    expect(pctDelta(10, undefined)).toBeNull();
    expect(pctDelta(10, 0)).toBeNull();
    expect(pctDelta(10, -1)).toBeNull();
    expect(pctDelta(Number.NaN, 10)).toBeNull();
  });
});

describe('sumPostWindows', () => {
  const now = Date.parse('2026-06-25T12:00:00.000Z');

  it('sums current and previous windows when loaded posts cover both', () => {
    const totals = sumPostWindows(
      [
        { date: '2026-06-23T12:00:00.000Z', views: 100, reactions: 10, forwards: 2, replies: 3 },
        { date: '2026-06-17T12:00:00.000Z', views: 80, reactions: 8, forwards: 1, replies: 1 },
        { date: '2026-06-10T11:59:59.000Z', views: 5, reactions: 1, forwards: 0, replies: 0 },
      ],
      7,
      now,
    );

    expect(totals).toEqual({
      current: { views: 100, reactions: 10, forwards: 2, replies: 3 },
      previous: { views: 80, reactions: 8, forwards: 1, replies: 1 },
    });
  });

  it('returns null when the loaded set does not reach the previous window start', () => {
    expect(
      sumPostWindows(
        [{ date: '2026-06-20T12:00:00.000Z', views: 100, reactions: 10, forwards: 2, replies: 3 }],
        7,
        now,
      ),
    ).toBeNull();
  });
});

describe('subscriberDelta', () => {
  it('compares the latest point with the point at the period boundary', () => {
    const now = Date.parse('2026-06-25T12:00:00.000Z');
    expect(
      subscriberDelta(
        [
          { day: '2026-05-25', subscribers: 900 },
          { day: '2026-05-26', subscribers: 1_000 },
          { day: '2026-06-25', subscribers: 1_100 },
        ],
        30,
        now,
      ),
    ).toEqual({ pct: 10, dir: 'up' });
  });
});
