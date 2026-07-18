import { describe, expect, it } from 'vitest';
import {
  aggregatePlotPoints,
  bucketPoints,
  densifyDayPoints,
  metricTotal,
  metricValue,
  strideEvery,
  type DayPoint,
} from './msSeries';
import type { MsPeriod } from './msPeriod';

const pt = (day: string, orders: number, sum: number): DayPoint => ({ day, orders, sum });

describe('metricValue — честный средний чек', () => {
  it('revenue = sum, orders = count', () => {
    expect(metricValue('revenue', pt('2026-03-01', 3, 1500))).toBe(1500);
    expect(metricValue('orders', pt('2026-03-01', 3, 1500))).toBe(3);
  });

  it('AOV = sum/orders, но null (не 0) без заказов — деление на ноль было бы ложью', () => {
    expect(metricValue('aov', pt('2026-03-01', 4, 2000))).toBe(500);
    expect(metricValue('aov', pt('2026-03-02', 0, 0))).toBeNull();
  });
});

describe('bucketPoints — грануляция суммирует, средний чек на границе бакета', () => {
  it('месяц: суммирует заказы и выручку по дням месяца', () => {
    const buckets = bucketPoints(
      [pt('2026-03-05', 1, 1000), pt('2026-03-20', 3, 1500), pt('2026-04-02', 2, 800)],
      'month',
    );
    expect(buckets).toEqual([pt('2026-03-01', 4, 2500), pt('2026-04-01', 2, 800)]);
  });

  it('средний чек бакета = sum(выручка)/sum(заказы), НЕ среднее дневных чеков', () => {
    // день A: чек 1000 (1 заказ), день B: чек 500 (3 заказа). Среднее дневных = 750, но честный
    // бакетный чек = 2500/4 = 625.
    const [march] = bucketPoints([pt('2026-03-05', 1, 1000), pt('2026-03-20', 3, 1500)], 'month');
    expect(metricValue('aov', march)).toBe(625);
  });

  it('day-грануляция — тождество', () => {
    const days = [pt('2026-03-01', 1, 100), pt('2026-03-02', 2, 200)];
    expect(bucketPoints(days, 'day')).toEqual(days);
  });
});

describe('densifyDayPoints — календарная сетка окна честными нулями', () => {
  const period: MsPeriod = { days: 7, from: '2026-03-01', to: '2026-03-07' };

  it('дозаполняет пропущенные дни окна нулями (бэк отдаёт только дни с заказами)', () => {
    const dense = densifyDayPoints([pt('2026-03-01', 2, 1000), pt('2026-03-05', 1, 800)], period);
    expect(dense).toHaveLength(7);
    expect(dense[0]).toEqual(pt('2026-03-01', 2, 1000));
    expect(dense[1]).toEqual(pt('2026-03-02', 0, 0));
    expect(dense[4]).toEqual(pt('2026-03-05', 1, 800));
    expect(dense.every((p, i) => i === 0 || p.day > dense[i - 1].day)).toBe(true);
  });
});

describe('aggregatePlotPoints — sparse-AOV не рвётся в россыпь точек', () => {
  const period: MsPeriod = { days: 7, from: '2026-03-01', to: '2026-03-07' };
  const dense = densifyDayPoints([pt('2026-03-01', 2, 1000), pt('2026-03-05', 1, 800)], period);

  it('выручка/заказы сохраняют полную сетку с честными нулями (непрерывная линия)', () => {
    const rev = aggregatePlotPoints(dense, 'revenue', 140);
    expect(rev).toHaveLength(7);
    // Нули присутствуют как реальные значения, а не как разрывы.
    expect(rev.map((p) => metricValue('revenue', p))).toEqual([1000, 0, 0, 0, 800, 0, 0]);
  });

  it('средний чек: только бакеты с заказами → непрерывный ряд наблюдений без null', () => {
    const aov = aggregatePlotPoints(dense, 'aov', 140);
    expect(aov.map((p) => p.day)).toEqual(['2026-03-01', '2026-03-05']);
    const values = aov.map((p) => metricValue('aov', p));
    expect(values).toEqual([500, 800]);
    // Ни одного null — общий LineChart нарисует сплошную линию, а не изолированные точки.
    expect(values.some((v) => v == null)).toBe(false);
  });

  it('честно обрабатывает 0 и 1 наблюдение среднего чека', () => {
    const emptyWin: MsPeriod = { days: 3, from: '2026-03-01', to: '2026-03-03' };
    // Ноль дней с заказами → пусто (вызывающий покажет «недостаточно бакетов»).
    expect(aggregatePlotPoints(densifyDayPoints([], emptyWin), 'aov', 140)).toEqual([]);
    // Ровно одно наблюдение → одна точка (вызывающий гейтит < 2 и не рисует линию).
    const one = aggregatePlotPoints(densifyDayPoints([pt('2026-03-02', 1, 400)], emptyWin), 'aov', 140);
    expect(one).toHaveLength(1);
    expect(metricValue('aov', one[0])).toBe(400);
  });
});

describe('metricTotal — итог окна', () => {
  const series = [pt('2026-03-01', 2, 1000), pt('2026-03-02', 0, 0), pt('2026-03-05', 3, 1500)];

  it('выручка/заказы — сумма', () => {
    expect(metricTotal(series, 'revenue')).toBe(2500);
    expect(metricTotal(series, 'orders')).toBe(5);
  });

  it('средний чек = sum(выручка)/sum(заказы), null без заказов', () => {
    expect(metricTotal(series, 'aov')).toBe(500);
    expect(metricTotal([pt('2026-03-02', 0, 0)], 'aov')).toBeNull();
  });
});

describe('strideEvery — прореживание сохраняет последнюю точку', () => {
  it('не трогает короткие серии', () => {
    expect(strideEvery([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });

  it('прореживает длинные, всегда оставляя последний элемент', () => {
    const arr = Array.from({ length: 10 }, (_, i) => i);
    const out = strideEvery(arr, 4);
    expect(out.length).toBeLessThanOrEqual(6);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(9);
  });
});
