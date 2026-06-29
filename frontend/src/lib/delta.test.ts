import { describe, expect, it } from 'vitest';
import { avgReachWindowDelta, dailyWindowDelta, pctDelta, subscriberChange, subscriberDelta, sumPostWindows } from '@/lib/delta';

describe('subscriberChange', () => {
  const now = Date.parse('2026-06-25T12:00:00.000Z');
  const rows = [
    { day: '2026-05-20', subscribers: 5000 },
    { day: '2026-05-26', subscribers: 4950 }, // ~30d baseline
    { day: '2026-06-25', subscribers: 4892 }, // latest
  ];

  it('returns the signed latest-minus-baseline change over the window', () => {
    expect(subscriberChange(rows, 30, now)).toBe(4892 - 4950);
  });

  it('returns null for all-time (days<=0) or when an endpoint is missing', () => {
    expect(subscriberChange(rows, 0, now)).toBeNull();
    expect(subscriberChange([{ day: '2026-06-25', subscribers: 100 }], 30, now)).toBeNull();
  });
});

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

describe('dailyWindowDelta', () => {
  const now = Date.parse('2026-06-25T12:00:00.000Z');
  const rows = [
    { day: '2026-06-24', views: 100 }, // current window
    { day: '2026-06-20', views: 50 }, //  current window
    { day: '2026-06-16', views: 40 }, //  previous window
    { day: '2026-06-12', views: 40 }, //  previous window
  ];

  it('sums a daily metric over current vs previous window', () => {
    // current = 150, previous = 80 → +87.5%
    expect(dailyWindowDelta(rows, (r) => Number(r.views), 7, now)).toEqual({ pct: 87.5, dir: 'up' });
  });

  it('returns null when a window has no data', () => {
    expect(dailyWindowDelta([{ day: '2026-06-24', views: 100 }], (r) => Number(r.views), 7, now)).toBeNull();
    expect(dailyWindowDelta(rows, (r) => Number(r.views), 0, now)).toBeNull(); // all-time
  });
});

describe('avgReachWindowDelta', () => {
  const now = Date.parse('2026-06-25T12:00:00.000Z');

  it('compares average views/post across windows', () => {
    // current avg = (100+200)/2 = 150, previous avg = 100/1 = 100 → +50%
    const delta = avgReachWindowDelta(
      [
        { date: '2026-06-24T00:00:00.000Z', views: 100 },
        { date: '2026-06-20T00:00:00.000Z', views: 200 },
        { date: '2026-06-15T00:00:00.000Z', views: 100 },
      ],
      7,
      now,
    );
    expect(delta).toEqual({ pct: 50, dir: 'up' });
  });

  it('returns null when the previous window has no posts', () => {
    expect(
      avgReachWindowDelta([{ date: '2026-06-24T00:00:00.000Z', views: 100 }], 7, now),
    ).toBeNull();
  });
});
