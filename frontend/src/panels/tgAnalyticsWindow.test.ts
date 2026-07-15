import { describe, expect, it } from 'vitest';
import { deriveFollowerFlows, deriveNetGrowth, windowGraphSeries } from './TgAnalytics';
import { calendarWindowForDays, calendarWindowForPeriod, widgetPeriodValue } from '@/lib/period';

const DAY = 24 * 60 * 60 * 1000;
// A fixed «now» so the calendar-window math is deterministic (real code reads Date.now()).
const NOW = Date.UTC(2026, 6, 15, 12, 0, 0);

/** `len` consecutive daily points ending today: xs ascending, oldest first. */
function dailySeries(len: number, value: (i: number) => number, endOffsetDays = 0) {
  const xs: number[] = [];
  const values: number[] = [];
  for (let i = 0; i < len; i++) {
    xs.push(NOW - (len - 1 - i + endOffsetDays) * DAY);
    values.push(value(i));
  }
  return { xs, values };
}

describe('periodWindow', () => {
  it('uses the page custom range verbatim, ignoring the days fallback', () => {
    const range = { from: NOW - 14 * DAY, to: NOW - 7 * DAY };
    // days is the fallback 30 for a custom range — the window must still be the range.
    const win = calendarWindowForPeriod(widgetPeriodValue(30, range), NOW);
    expect(win).toEqual(range);
  });

  it('falls back to the last N calendar days for a preset', () => {
    expect(calendarWindowForPeriod(widgetPeriodValue(7), NOW)).toEqual({ from: NOW - 7 * DAY, to: NOW });
  });

  it('is unbounded («Всё») for days 0 without a range', () => {
    expect(calendarWindowForPeriod(widgetPeriodValue(0), NOW)).toBeNull();
  });
});

describe('windowGraphSeries — calendar windowing', () => {
  it('keeps points by DATE, not the last N archived points', () => {
    const { xs, values } = dailySeries(60, (i) => i);
    const win = calendarWindowForDays(7, NOW);
    const w = windowGraphSeries(values, xs, win, 'просмотров');
    const expected = values.filter((_, i) => xs[i]! >= win!.from && xs[i]! <= win!.to);
    expect(w.values).toEqual(expected);
    // A 7-day calendar window on stale-free daily data is far fewer than all 60 points.
    expect(w.values.length).toBeLessThan(values.length);
  });

  it('shows the true current window (empty) when the archive is stale', () => {
    // 30 daily points but the newest is 10 days old — a 7-day window contains none of them.
    const { xs, values } = dailySeries(30, () => 5, /* endOffsetDays */ 10);
    const w = windowGraphSeries(values, xs, calendarWindowForDays(7, NOW), 'просмотров');
    expect(w.values).toEqual([]);
    expect(w.total).toBe(0);
  });

  it('respects a custom range that ends before the last archived point', () => {
    const { xs, values } = dailySeries(60, (i) => i);
    const range = { from: NOW - 20 * DAY, to: NOW - 10 * DAY };
    const w = windowGraphSeries(values, xs, range, 'просмотров');
    const expected = values.filter((_, i) => xs[i]! >= range.from && xs[i]! <= range.to);
    expect(w.values).toEqual(expected);
    expect(w.values).not.toContain(values[values.length - 1]);
  });

  it('compares against the previous equal-length window', () => {
    const { xs, values } = dailySeries(60, () => 10);
    const win = calendarWindowForDays(10, NOW);
    const w = windowGraphSeries(values, xs, win, 'просмотров');
    const prevFrom = win!.from - (win!.to - win!.from);
    const expectedPrev = values
      .filter((_, i) => xs[i]! >= prevFrom && xs[i]! < win!.from)
      .reduce((a, v) => a + v, 0);
    expect(w.prevTotal).toBe(expectedPrev);
    expect(w.prevTotal).toBeGreaterThan(0);
  });

  it('never fabricates a previous window on «Всё» or without enough history', () => {
    const { xs, values } = dailySeries(60, () => 10);
    expect(windowGraphSeries(values, xs, null, 'просмотров').prevTotal).toBeNull();
    // Only 5 days of history — a 10-day window has no full previous window to compare against.
    const short = dailySeries(5, () => 10);
    expect(windowGraphSeries(short.values, short.xs, calendarWindowForDays(10, NOW), 'просмотров').prevTotal).toBeNull();
  });

  it('keeps the whole series when it has no usable timestamps', () => {
    const values = [1, 2, 3, 4];
    const w = windowGraphSeries(values, [], calendarWindowForDays(7, NOW), 'просмотров');
    expect(w.values).toEqual(values);
  });
});

describe('deriveNetGrowth — follows the window', () => {
  it('nets joined − left over the calendar window', () => {
    const { xs } = dailySeries(60, () => 0);
    const joined = xs.map(() => 10);
    const left = xs.map((_, i) => (i % 2 === 0 ? 3 : 7));
    const graphs = {
      followers: { x: xs, series: [{ name: 'Joined', values: joined }, { name: 'Left', values: left }] },
    } as unknown as Parameters<typeof deriveNetGrowth>[0];
    const win = calendarWindowForDays(7, NOW);
    const net = deriveNetGrowth(graphs, win);
    const expected = joined
      .map((j, i) => j - left[i]!)
      .filter((_, i) => xs[i]! >= win!.from && xs[i]! <= win!.to);
    expect(net.values).toEqual(expected);
    expect(net.total).toBe(expected.reduce((a, v) => a + v, 0));
    expect(net.titles).toHaveLength(expected.length);
  });

  it('returns empty when either series is missing', () => {
    const graphs = {
      followers: { x: [NOW], series: [{ name: 'Joined', values: [10] }] },
    } as unknown as Parameters<typeof deriveNetGrowth>[0];
    expect(deriveNetGrowth(graphs, null).values).toEqual([]);
  });

  it('uses the same selected window for joined/left churn totals', () => {
    const { xs } = dailySeries(20, () => 0);
    const graphs = {
      followers: {
        x: xs,
        series: [
          { name: 'Joined', values: xs.map((_, i) => i + 1) },
          { name: 'Left', values: xs.map(() => 2) },
        ],
      },
    } as unknown as Parameters<typeof deriveFollowerFlows>[0];
    const win = { from: NOW - 4 * DAY, to: NOW };
    const flow = deriveFollowerFlows(graphs, win);
    expect(flow.values).toHaveLength(5);
    expect(flow.joinedTotal).toBe(90);
    expect(flow.leftTotal).toBe(10);
    expect(flow.total).toBe(80);
  });
});
