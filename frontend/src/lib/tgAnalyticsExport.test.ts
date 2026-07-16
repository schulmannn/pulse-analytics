import { describe, expect, it } from 'vitest';
import { buildTgAnalyticsRows, tgDailySeriesFromGraphs, type TgDailySeries } from '@/lib/tgAnalyticsExport';
import { endOfLocalDay, startOfLocalDay } from '@/lib/period';
import type { TgGraphs } from '@/api/schemas';

// One value per calendar day at local noon (avoids day-boundary edge cases), value = day-of-month.
function juneSeries(metric = 'Просмотры канала', unit = 'просмотры'): TgDailySeries {
  const values: number[] = [];
  const x: number[] = [];
  for (let day = 1; day <= 30; day++) {
    values.push(day);
    x.push(new Date(2026, 5, day, 12, 0, 0).getTime());
  }
  return { metric, unit, values, x };
}

const days = (rows: { date?: string }[]) => rows.map((r) => r.date);

describe('buildTgAnalyticsRows', () => {
  it('windows to the current top-bar window and emits the equal previous window', () => {
    const window = { from: startOfLocalDay(new Date(2026, 5, 15).getTime()), to: endOfLocalDay(new Date(2026, 5, 21).getTime()) };
    const rows = buildTgAnalyticsRows({ source: 'chan', window, series: [juneSeries()] });

    const current = rows.filter((r) => r.scope === 'current');
    const previous = rows.filter((r) => r.scope === 'previous');
    // Current = June 15..21 (inclusive, 7 days); no leakage before/after.
    expect(days(current)).toEqual(['2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18', '2026-06-19', '2026-06-20', '2026-06-21']);
    expect(current.every((r) => r.value >= 15 && r.value <= 21)).toBe(true);
    // Previous = the equal preceding 7-day window, June 8..14 (real archived data, not fabricated).
    expect(days(previous)).toEqual(['2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13', '2026-06-14']);
    expect(current.every((r) => r.from === '2026-06-15' && r.to === '2026-06-21')).toBe(true);
    expect(previous.every((r) => r.from === '2026-06-08' && r.to === '2026-06-14')).toBe(true);
  });

  it('has no previous window when the archive does not reach back far enough', () => {
    // Window is the first week of the series → previous week has no data.
    const window = { from: startOfLocalDay(new Date(2026, 5, 3).getTime()), to: endOfLocalDay(new Date(2026, 5, 9).getTime()) };
    const rows = buildTgAnalyticsRows({ source: 'chan', window, series: [juneSeries()] });
    expect(rows.some((r) => r.scope === 'previous')).toBe(false);
    expect(rows.filter((r) => r.scope === 'current').length).toBe(7);
  });

  it('«Всё» (null window) exports everything with no previous and data-extent bounds', () => {
    const rows = buildTgAnalyticsRows({ source: 'chan', window: null, series: [juneSeries()] });
    expect(rows.length).toBe(30);
    expect(rows.some((r) => r.scope === 'previous')).toBe(false);
    expect(rows[0]?.from).toBe('2026-06-01');
    expect(rows[0]?.to).toBe('2026-06-30');
  });

  it('drops points with a non-finite timestamp or value instead of fabricating data', () => {
    const series: TgDailySeries = {
      metric: 'Репосты',
      unit: 'репосты',
      values: [Number.NaN, 2, 3],
      x: [new Date(2026, 5, 9, 12).getTime(), new Date(2026, 5, 10, 12).getTime(), Number.NaN],
    };
    const rows = buildTgAnalyticsRows({ source: 'chan', window: null, series: [series] });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.date).toBe('2026-06-10');
  });
});

describe('tgDailySeriesFromGraphs', () => {
  it('picks views, reposts and net follower growth by name', () => {
    const graphs = {
      interactions: {
        x: [1, 2],
        series: [
          { name: 'Views', values: [10, 20] },
          { name: 'Shares', values: [1, 2] },
        ],
      },
      followers: {
        x: [1, 2],
        series: [
          { name: 'Joined', values: [5, 6] },
          { name: 'Left', values: [2, 1] },
        ],
      },
    } as unknown as TgGraphs;
    const series = tgDailySeriesFromGraphs(graphs);
    expect(series.map((s) => s.metric)).toEqual(['Просмотры канала', 'Репосты', 'Чистый прирост подписчиков']);
    const net = series.find((s) => s.metric === 'Чистый прирост подписчиков');
    expect(net?.values).toEqual([3, 5]); // 5-2, 6-1
  });

  it('returns nothing when graphs are absent', () => {
    expect(tgDailySeriesFromGraphs(undefined)).toEqual([]);
  });

  it('does not relabel an unknown graph series as reposts', () => {
    const graphs = {
      interactions: {
        x: [1],
        series: [
          { name: 'Views', values: [10] },
          { name: 'Reactions', values: [4] },
        ],
      },
    } as unknown as TgGraphs;
    expect(tgDailySeriesFromGraphs(graphs).map((s) => s.metric)).toEqual(['Просмотры канала']);
  });
});
