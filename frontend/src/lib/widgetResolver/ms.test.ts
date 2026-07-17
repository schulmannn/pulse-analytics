import { describe, expect, it } from 'vitest';
import { resolveWidgetMetric } from '@/lib/resolveWidgetMetric';
import type { DataContext } from '@/lib/widgetResolver/types';
import type { WidgetConfig } from '@/lib/widgetConfig';

// Резолвер МС-семейства: серии приходят СЕРВЕР-НАРЕЗАННЫМИ (useMsSummary окна виджета), рубли —
// уже рубли; резолвер только мапит и лепит хедлайн с ₽.

const SUMMARY = {
  revenue: {
    total: 150_000,
    series: [
      { day: '2026-07-15', value: 100_000 },
      { day: '2026-07-16', value: 50_000 },
    ],
  },
  orders: {
    totalCount: 3,
    totalSum: 150_000,
    series: [
      { day: '2026-07-15', count: 2, sum: 100_000 },
      { day: '2026-07-16', count: 0, sum: 0 },
      { day: '2026-07-17', count: 1, sum: 50_000 },
    ],
  },
};

function ctxWith(summary: typeof SUMMARY | undefined): DataContext {
  return { now: Date.parse('2026-07-17T12:00:00'), days: 30, range: null, inRange: () => true, ms: { summary } };
}

function cfg(metricId: string): WidgetConfig {
  return { id: 'w1', metricId, viz: 'line' };
}

describe('resolveMsMetric', () => {
  it('ms.revenue: серия из summary, хедлайн в рублях, meta сети ms', () => {
    const out = resolveWidgetMetric(cfg('ms.revenue'), ctxWith(SUMMARY));
    expect(out.empty).toBeFalsy();
    expect(out.series?.map((p) => p.value)).toEqual([100_000, 50_000]);
    expect(out.valueRaw).toBe(150_000);
    expect(out.value).toContain('₽');
    expect(out.unit).toBe('currency');
    expect(out.meta?.network).toBe('ms');
  });

  it('ms.orders: счётчик заказов без ₽', () => {
    const out = resolveWidgetMetric(cfg('ms.orders'), ctxWith(SUMMARY));
    expect(out.series?.map((p) => p.value)).toEqual([2, 0, 1]);
    expect(out.valueRaw).toBe(3);
    expect(out.value).not.toContain('₽');
  });

  it('ms.avgCheck: день без заказов выпадает из серии (нет чека — нечего усреднять)', () => {
    const out = resolveWidgetMetric(cfg('ms.avgCheck'), ctxWith(SUMMARY));
    expect(out.series?.map((p) => p.date)).toEqual(['2026-07-15', '2026-07-17']);
    expect(out.series?.map((p) => p.value)).toEqual([50_000, 50_000]);
    expect(out.valueRaw).toBe(50_000);
    expect(out.value).toContain('₽');
  });

  it('без summary (данные не загружены/канал не МС) — честная пустота', () => {
    for (const id of ['ms.revenue', 'ms.orders', 'ms.avgCheck']) {
      expect(resolveWidgetMetric(cfg(id), ctxWith(undefined)).empty).toBe(true);
    }
  });

  it('пустые серии — пустота, не нулевой график', () => {
    const empty = {
      revenue: { total: 0, series: [] },
      orders: { totalCount: 0, totalSum: 0, series: [] },
    };
    expect(resolveWidgetMetric(cfg('ms.revenue'), ctxWith(empty as typeof SUMMARY)).empty).toBe(true);
    expect(resolveWidgetMetric(cfg('ms.avgCheck'), ctxWith(empty as typeof SUMMARY)).empty).toBe(true);
  });
});
