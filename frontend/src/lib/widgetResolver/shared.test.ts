import { describe, expect, it } from 'vitest';
import { CHART_MAX_POINTS } from '@/lib/msSeries';
import { resolveWidgetMetric } from '@/lib/resolveWidgetMetric';
import type { WidgetConfig } from '@/lib/widgetConfig';
import { capResultSeries } from '@/lib/widgetResolver/shared';
import type { DataContext, WidgetResult } from '@/lib/widgetResolver/types';

// Кап баров длиннее CHART_MAX_POINTS: НЕ децимация (пропуски дней в барах врут), а честная
// календарная недельная агрегация (Monday-anchored — зеркало windowGraphSeries): flow — сумма
// корзины, level — last-of-bucket; date корзины = понедельник, маркер «по неделям» — в
// meta.periodLabel (титулы точек строит widgetRender.seriesToChart из тех же дат-понедельников).

const DAY_MS = 24 * 60 * 60 * 1000;
// 2026-01-05 — понедельник: серия стартует с начала календарной недели, полные корзины по 7 дней.
const BASE = Date.parse('2026-01-05T00:00:00Z');
const dayKey = (i: number) => new Date(BASE + i * DAY_MS).toISOString().slice(0, 10);

/** len дневных точек подряд; value(i) задаёт значение дня. */
function dailySeries(len: number, value: (i: number) => number) {
  return Array.from({ length: len }, (_, i) => ({ date: dayKey(i), value: value(i) }));
}

const LONG = CHART_MAX_POINTS + 70; // 210 дней = 30 полных недель

function result(over: Partial<WidgetResult>): WidgetResult {
  return { metricId: 'x', kind: 'series', unit: 'number', ...over };
}

describe('capResultSeries: недельная агрегация баров', () => {
  it('flow: длинная дневная серия суммируется по календарным неделям, даты — понедельники', () => {
    const out = capResultSeries(result({ series: dailySeries(LONG, () => 1) }), 'bar');
    const weekly = out.series ?? [];
    expect(weekly).toHaveLength(LONG / 7);
    expect(weekly.every((p) => p.value === 7)).toBe(true);
    expect(weekly.every((p) => new Date(`${p.date}T00:00:00Z`).getUTCDay() === 1)).toBe(true);
    expect(weekly[0]?.date).toBe('2026-01-05');
  });

  it('level: корзина берёт last-of-bucket, не сумму', () => {
    const out = capResultSeries(result({ series: dailySeries(LONG, (i) => i + 1) }), 'bar', 'level');
    // Последний день k-й недели — индекс 7k+6, значение 7k+7.
    expect((out.series ?? []).map((p) => p.value)).toEqual(
      Array.from({ length: LONG / 7 }, (_, k) => 7 * k + 7),
    );
  });

  it('маркер честности: «по неделям» дописывается в meta.periodLabel', () => {
    const bare = capResultSeries(result({ series: dailySeries(LONG, () => 1) }), 'bar');
    expect(bare.meta?.periodLabel).toBe('по неделям');
    const withLabel = capResultSeries(
      result({ series: dailySeries(LONG, () => 1), meta: { periodLabel: 'за всё время' } }),
      'bar',
    );
    expect(withLabel.meta?.periodLabel).toBe('за всё время · по неделям');
  });

  it('короткая серия баров не трогается (ни агрегации, ни меты)', () => {
    const series = dailySeries(CHART_MAX_POINTS, () => 1);
    const out = capResultSeries(result({ series }), 'bar');
    expect(out.series).toBe(series);
    expect(out.meta).toBeUndefined();
  });

  it('ghost после агрегации отбрасывается с честной comparisonNote', () => {
    const out = capResultSeries(
      result({ series: dailySeries(LONG, () => 1), ghost: new Array(LONG).fill(1), ghostLabel: 'прошлый период' }),
      'bar',
    );
    expect(out.ghost).toBeUndefined();
    expect(out.ghostLabel).toBeUndefined();
    expect(out.meta?.comparisonNote).toBe('сравнение недоступно для агрегированных недель');
  });

  it('линии капаются по-прежнему визуально (LTTB), без недельной меты', () => {
    const out = capResultSeries(result({ series: dailySeries(LONG, (i) => i % 5) }), 'line');
    expect(out.series).toHaveLength(CHART_MAX_POINTS);
    expect(out.meta).toBeUndefined();
  });
});

// Прокидка kind из resolveWidgetMetric: канон — seriesAgg каталога, ms.avgCheck докласифицирован
// уровнем (сумма дневных СРЕДНИХ чеков за неделю завышала бы значение на порядок).
describe('resolveWidgetMetric: kind для недельного капа баров', () => {
  const summary = {
    revenue: {
      total: LONG * 1000,
      series: Array.from({ length: LONG }, (_, i) => ({ day: dayKey(i), value: 1000 })),
    },
    orders: {
      totalCount: LONG,
      totalSum: LONG * 1000,
      series: Array.from({ length: LONG }, (_, i) => ({ day: dayKey(i), count: 1, sum: (i + 1) * 1000 })),
    },
  };
  const ctx: DataContext = { now: BASE + LONG * DAY_MS, days: 0, range: null, inRange: () => true, ms: { summary } };
  const cfg = (metricId: string): WidgetConfig => ({ id: 'w1', metricId, viz: 'bar' });

  it('ms.revenue (flow) — недельные суммы; stats остаются от полной дневной серии', () => {
    const out = resolveWidgetMetric(cfg('ms.revenue'), ctx);
    const weekly = out.series ?? [];
    expect(weekly).toHaveLength(LONG / 7);
    expect(weekly.every((p) => p.value === 7000)).toBe(true);
    expect(out.stats).toEqual({ max: 1000, avg: 1000 });
    expect(out.meta?.periodLabel).toBe('за всё время · по неделям');
  });

  it('ms.avgCheck (level-словарик) — last-of-bucket, не сумма средних', () => {
    const out = resolveWidgetMetric(cfg('ms.avgCheck'), ctx);
    // Дневной чек = (i+1)·1000; последний день k-й недели даёт (7k+7)·1000.
    expect((out.series ?? []).map((p) => p.value)).toEqual(
      Array.from({ length: LONG / 7 }, (_, k) => (7 * k + 7) * 1000),
    );
  });
});
