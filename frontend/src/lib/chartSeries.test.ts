import { describe, expect, it } from 'vitest';
import {
  bucketSeries,
  densifyWindow,
  prepareChartSeries,
  type ChartPoint,
  type SeriesKind,
} from '@/lib/chartSeries';
import { CHART_MAX_POINTS, pickIndexes } from '@/lib/downsample';
import type { SeriesAggregation } from '@/lib/widgetMetrics';
import { capResultSeries } from '@/lib/widgetResolver/shared';
import type { WidgetResult } from '@/lib/widgetResolver/types';
import { seriesToChart } from '@/lib/widgetRender';

const DAY_MS = 24 * 60 * 60 * 1000;
// 2026-01-05 — понедельник: полные календарные недели по 7 дней.
const BASE = Date.parse('2026-01-05T00:00:00Z');
const dayKey = (i: number, base = BASE) => new Date(base + i * DAY_MS).toISOString().slice(0, 10);

function daily(len: number, value: (i: number) => number | null, base = BASE): ChartPoint[] {
  return Array.from({ length: len }, (_, i) => ({ day: dayKey(i, base), value: value(i) }));
}

const LONG = CHART_MAX_POINTS + 70; // 210 дней = 30 полных недель

describe('densifyWindow — пропуск не становится нулём', () => {
  const window = { from: '2026-03-01', to: '2026-03-05' };

  it("missing 'null': день без точки — пропуск; честный ноль и явный пропуск остаются как были", () => {
    const out = densifyWindow(
      [
        { day: '2026-03-02', value: 0 },
        { day: '2026-03-04', value: null },
        { day: '2026-03-05', value: 7 },
      ],
      window,
      { missing: 'null' },
    );
    expect(out.map((p) => p.day)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']);
    expect(out.map((p) => p.value)).toEqual([null, 0, null, null, 7]);
  });

  it("missing 'zero': ноль только внутри покрытия, вне выгрузки — пропуск", () => {
    const points = [{ day: '2026-03-02', value: 5 }];
    expect(densifyWindow(points, window, { missing: 'zero' }).map((p) => p.value)).toEqual([0, 5, 0, 0, 0]);
    // СДЭК: последняя выгрузка покрыла дни по 3 марта — 4 и 5 марта «не загружено», а не «продаж не было».
    expect(
      densifyWindow(points, window, { missing: 'zero', covered: { to: '2026-03-03' } }).map((p) => p.value),
    ).toEqual([0, 5, 0, null, null]);
    expect(
      densifyWindow(points, window, { missing: 'zero', covered: (day) => day !== '2026-03-01' }).map((p) => p.value),
    ).toEqual([null, 5, 0, 0, 0]);
  });

  it('ratio: честный нулевой день — {num: 0, den: 0}, а значение не определено', () => {
    const out = densifyWindow([{ day: '2026-03-01', value: 100, num: 300, den: 3 }], { from: '2026-03-01', to: '2026-03-02' }, {
      missing: 'zero',
      kind: 'ratio',
    });
    expect(out[1]).toEqual({ day: '2026-03-02', value: null, num: 0, den: 0 });
  });

  it('без окна — сетка по крайним дням точек; кривые ключи и точки вне окна отбрасываются', () => {
    const out = densifyWindow(
      [
        { day: '2026-02-27', value: 1 },
        { day: '2026-02-31', value: 99 }, // Date.parse молча уехал бы в март
        { day: 'мусор', value: 99 },
        { day: '2026-03-02', value: 3 },
      ],
      null,
      { missing: 'null' },
    );
    expect(out.map((p) => [p.day, p.value])).toEqual([
      ['2026-02-27', 1],
      ['2026-02-28', null],
      ['2026-03-01', null],
      ['2026-03-02', 3],
    ]);
    expect(densifyWindow([{ day: '2026-02-27', value: 1 }], window, { missing: 'null' }).every((p) => p.value === null)).toBe(true);
    expect(densifyWindow([], { from: '2026-02-31', to: '2026-03-02' }, { missing: 'null' })).toEqual([]);
  });

  // Страж осмыслен только под зоной с переходом: CI фронта идёт в UTC, где арифметика от локальной
  // полуночи тоже прошла бы. Окна — переходы Европы (29 марта) и США (8 марта) 2026-го, чтобы
  // регрессию ловил прогон под любой из этих зон (TZ=Europe/Berlin, TZ=America/New_York).
  it('окно через переход на летнее время — ровно по дню на дату', () => {
    const eu = densifyWindow([], { from: '2026-03-27', to: '2026-04-01' }, { missing: 'zero' });
    expect(eu.map((p) => p.day)).toEqual(['2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31', '2026-04-01']);
    const us = densifyWindow([], { from: '2026-03-06', to: '2026-03-10' }, { missing: 'zero' });
    expect(us.map((p) => p.day)).toEqual(['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']);
  });
});

describe('bucketSeries — корзина по типу метрики', () => {
  it('flow: сумма; пропуск не прибавляет ноль; корзина из одних пропусков — пропуск', () => {
    const points = daily(21, (i) => (i >= 7 && i < 14 ? null : i === 3 ? null : 1));
    const out = bucketSeries(points, null, 'week', 'flow');
    expect(out).toEqual([
      { day: '2026-01-05', value: 6 },
      { day: '2026-01-12', value: null },
      { day: '2026-01-19', value: 7 },
    ]);
  });

  it('stock: последнее значение корзины; хвостовой пропуск не становится «последним»', () => {
    const points = daily(14, (i) => (i === 13 ? null : 100 + i));
    expect(bucketSeries(points, null, 'week', 'stock').map((p) => p.value)).toEqual([106, 112]);
  });

  it('ratio: Σnum/Σden, а не среднее дневных средних', () => {
    // 1 пост на 100 просмотров и 3 поста на 600: средние 100 и 200, «среднее средних» 150, честно — 700/4.
    const points: ChartPoint[] = [
      { day: '2026-01-05', value: 100, num: 100, den: 1 },
      { day: '2026-01-06', value: 200, num: 600, den: 3 },
    ];
    expect(bucketSeries(points, null, 'week', 'ratio')).toEqual([{ day: '2026-01-05', value: 175, num: 700, den: 4 }]);
  });

  it('ratio: Σden = 0 — значение не определено; без числителя и знаменателя складывать нельзя', () => {
    const zeroDays: ChartPoint[] = [
      { day: '2026-01-05', value: null, num: 0, den: 0 },
      { day: '2026-01-06', value: null, num: 0, den: 0 },
    ];
    expect(bucketSeries(zeroDays, null, 'week', 'ratio')[0]?.value).toBeNull();
    const bare: ChartPoint[] = [
      { day: '2026-01-05', value: 100 },
      { day: '2026-01-06', value: 200 },
    ];
    expect(bucketSeries(bare, null, 'week', 'ratio')[0]?.value).toBeNull();
    // Одно наблюдение — само себе отношение: усреднять нечего.
    expect(bucketSeries([bare[0]], null, 'week', 'ratio')[0]?.value).toBe(100);
  });

  it('ratio: честные нулевые дни уплотнения не меняют корзину — важно не то, чем залиты дыры', () => {
    const window = { from: '2026-01-05', to: '2026-01-11' };
    const one: ChartPoint[] = [{ day: '2026-01-07', value: 100 }];
    const zeroFilled = densifyWindow(one, window, { missing: 'zero', kind: 'ratio' });
    const nullFilled = densifyWindow(one, window, { missing: 'null', kind: 'ratio' });
    expect(bucketSeries(zeroFilled, window, 'week', 'ratio')).toEqual([{ day: '2026-01-05', value: 100 }]);
    expect(bucketSeries(nullFilled, window, 'week', 'ratio')).toEqual([{ day: '2026-01-05', value: 100 }]);
    // Точка без числителя рядом с весомой — вес неизвестен, складывать нельзя.
    const mixed: ChartPoint[] = [...one, { day: '2026-01-08', value: 200, num: 600, den: 3 }];
    expect(bucketSeries(mixed, window, 'week', 'ratio')[0]?.value).toBeNull();
  });

  it('точки вне окна не попадают в крайние неполные корзины', () => {
    // Окно среда 7 — вторник 13 января: недели 5 и 12 января обе неполные.
    const window = { from: '2026-01-07', to: '2026-01-13' };
    const points: ChartPoint[] = [
      { day: '2026-01-05', value: 1000 }, // понедельник до окна
      { day: '2026-01-08', value: 3 },
      { day: '2026-01-12', value: 5 },
      { day: '2026-01-15', value: 1000 }, // четверг после окна
    ];
    expect(bucketSeries(points, window, 'week', 'flow')).toEqual([
      { day: '2026-01-05', value: 3 },
      { day: '2026-01-12', value: 5 },
    ]);
    expect(bucketSeries(points, window, 'week', 'stock').map((p) => p.value)).toEqual([3, 5]);
  });

  it('с окном — каждая корзина окна, пустая — пропуск; ключи месяцев как у резолвера', () => {
    const out = bucketSeries([{ day: '2026-02-10', value: 4 }], { from: '2026-01-20', to: '2026-03-02' }, 'month', 'flow');
    expect(out).toEqual([
      { day: '2026-01', value: null },
      { day: '2026-02', value: 4 },
      { day: '2026-03', value: null },
    ]);
    const weeks = bucketSeries([], { from: '2026-01-07', to: '2026-01-19' }, 'week', 'flow');
    expect(weeks.map((p) => p.day)).toEqual(['2026-01-05', '2026-01-12', '2026-01-19']);
  });
});

describe('prepareChartSeries — кап одной политикой', () => {
  it('короткий ряд не трогается: пропуск остаётся пропуском и подписан словами', () => {
    const points = daily(5, (i) => (i === 2 ? null : i));
    const out = prepareChartSeries({ points, viz: 'bar', kind: 'flow', unit: 'number' });
    expect(out.values).toEqual([0, 1, null, 3, 4]);
    expect(out.sampledIdx).toEqual([0, 1, 2, 3, 4]);
    expect(out.grain).toBe('day');
    expect(out.titles[2]).toBe(`${out.labels[2]}: данных нет`);
    expect(out.ghost).toBeNull();
    expect(out.ghostTitles).toBeNull();
  });

  it('линия без пропусков и призрака — LTTB: потолок, концы, карта индексов', () => {
    const points = daily(LONG, (i) => Math.sin(i / 7) * 50 + i);
    const out = prepareChartSeries({ points, viz: 'line', kind: 'flow', unit: 'views' });
    expect(out.values).toHaveLength(CHART_MAX_POINTS);
    expect(out.sampledIdx[0]).toBe(0);
    expect(out.sampledIdx.at(-1)).toBe(LONG - 1);
    out.sampledIdx.forEach((i, k) => {
      expect(out.values[k]).toBe(points[i].value);
    });
  });

  it('линия с пропусками — равный шаг, разрыв сохраняется на месте, а не проваливается в ноль', () => {
    // Шаг ceil(210/140) = 2 — чётные индексы попадают в выборку.
    const points = daily(LONG, (i) => (i % 20 === 0 ? null : 10));
    const out = prepareChartSeries({ points, viz: 'line', kind: 'flow', unit: 'number' });
    expect(out.sampledIdx.slice(0, 4)).toEqual([0, 2, 4, 6]);
    out.sampledIdx.forEach((i, k) => {
      expect(out.values[k]).toBe(points[i].value);
    });
    expect(out.values.filter((v) => v === null).length).toBeGreaterThan(0);
    expect(out.values).not.toContain(0);
  });

  it('призрак линии — теми же индексами и со своими датами в подписи', () => {
    const points = daily(LONG, (i) => i);
    const ghost = daily(LONG, (i) => 1000 + i, BASE - 365 * DAY_MS);
    const out = prepareChartSeries({ points, ghost, viz: 'line', kind: 'flow', unit: 'number' });
    expect(out.ghost).toHaveLength(out.values.length);
    out.sampledIdx.forEach((i, k) => {
      expect(out.values[k]).toBe(i);
      expect(out.ghost?.[k]).toBe(1000 + i);
    });
    expect(out.ghostTitles?.[0]).toBe('5 янв.: 1k');
  });

  it('призрак другой длины не рисуется — никаких чужих дат', () => {
    const points = daily(LONG, () => 1);
    const out = prepareChartSeries({ points, ghost: daily(LONG - 3, () => 2), viz: 'line', kind: 'flow', unit: 'number' });
    expect(out.ghost).toBeNull();
    expect(out.ghostTitles).toBeNull();
  });

  it('длинные столбцы — честные недели; sampledIdx — первая точка корзины', () => {
    const points = daily(LONG, (i) => i);
    const out = prepareChartSeries({ points, viz: 'bar', kind: 'flow', unit: 'number' });
    expect(out.grain).toBe('week');
    expect(out.values).toHaveLength(LONG / 7);
    expect(out.sampledIdx).toEqual(Array.from({ length: LONG / 7 }, (_, k) => 7 * k));
    // Корзина k покрывает исходные [sampledIdx[k], sampledIdx[k+1]).
    const ends = [...out.sampledIdx.slice(1), LONG];
    out.sampledIdx.forEach((start, k) => {
      const sum = points.slice(start, ends[k]).reduce((a, p) => a + (p.value ?? 0), 0);
      expect(out.values[k]).toBe(sum);
    });
    expect(out.titles[0]).toBe('5 янв.: 21 · неделя');
  });

  it('призрак столбцов сводится теми же неделями вместе с рядом и подписан своими днями', () => {
    const points = daily(LONG, () => 1);
    // Прошлое окно сдвинуто на 210 дней — его «недели» начинаются не с понедельника.
    const ghost = daily(LONG, (i) => (i < 7 ? null : 2), BASE - LONG * DAY_MS);
    const out = prepareChartSeries({ points, ghost, viz: 'bar', kind: 'flow', unit: 'number' });
    expect(out.ghost).toHaveLength(out.values.length);
    expect(out.ghost?.[0]).toBeNull(); // неделя из одних пропусков — пропуск, не 0
    expect(out.ghost?.slice(1).every((v) => v === 14)).toBe(true);
    expect(out.ghostTitles?.[0]).toBe('9 июн. – 15 июн.: данных нет');
    expect(out.ghostTitles?.[1]).toBe('16 июн. – 22 июн.: 14');
  });

  it('столбцы stock и ratio: last-of-bucket и Σnum/Σden — и у ряда, и у призрака', () => {
    const levels = prepareChartSeries({ points: daily(LONG, (i) => i), viz: 'bar', kind: 'stock', unit: 'number' });
    expect(levels.values).toEqual(Array.from({ length: LONG / 7 }, (_, k) => 7 * k + 6));

    // Чётный день — 1 пост на 100, нечётный — 3 поста на 600: среднее средних 150, честно — 175 за пару.
    const ratioDays = (base = BASE) =>
      Array.from({ length: LONG }, (_, i) =>
        i % 2 === 0
          ? { day: dayKey(i, base), value: 100, num: 100, den: 1 }
          : { day: dayKey(i, base), value: 200, num: 600, den: 3 },
      );
    const out = prepareChartSeries({
      points: ratioDays(),
      ghost: ratioDays(BASE - LONG * DAY_MS),
      viz: 'bar',
      kind: 'ratio',
      unit: 'views',
    });
    // Неделя 0: дни 0..6 — четыре «чётных» (400/4) и три «нечётных» (1800/9) → 2200/13.
    expect(out.values[0]).toBeCloseTo(2200 / 13, 10);
    expect(out.ghost?.[0]).toBeCloseTo(2200 / 13, 10);
  });

  it('если и недель больше потолка — месяцы', () => {
    // 120 дней с 5 января: 18 недель > 10 → месяцы.
    const points = daily(120, () => 1);
    const out = prepareChartSeries({ points, viz: 'bar', kind: 'flow', unit: 'number', maxPoints: 10 });
    expect(out.grain).toBe('month');
    expect(out.values).toEqual([27, 28, 31, 30, 4]);
    expect(out.sampledIdx).toEqual([0, 27, 55, 86, 116]);
  });
});

// СНИМОК РАСХОЖДЕНИЯ С capResultSeries. Главная пока идёт через capResultSeries (widgetResolver/
// shared) — переключение на prepareChartSeries видимо пользователю и делается отдельным шагом (3.5,
// 3.9). Здесь зафиксировано, в чём политики СОВПАДАЮТ (переход там ничего не меняет — ни точки, ни
// подписи тултипа) и КАЖДОЕ известное расхождение. Падение этого блока значит, что одна из политик
// сдвинулась молча: такой сдвиг должен быть осознанным и попасть в описание PR.
describe('снимок расхождения с capResultSeries (Главная)', () => {
  const CAP_KIND: Record<SeriesKind, SeriesAggregation> = { flow: 'flow', stock: 'level', ratio: 'mean' };

  function viaCap(points: ChartPoint[], viz: 'line' | 'bar', kind: SeriesKind, ghost?: ChartPoint[]) {
    const result: WidgetResult = {
      metricId: 'x',
      kind: 'series',
      unit: 'number',
      series: points.map((p) => ({ date: p.day, value: p.value })),
      ...(ghost ? { ghost: ghost.map((p) => p.value), ghostLabel: 'прошлый период' } : {}),
    };
    const capped = capResultSeries(result, viz, CAP_KIND[kind]);
    const { values, labels, titles, axisLabels } = seriesToChart(capped);
    return { values, labels, titles, axisLabels, ghost: capped.ghost ?? null, meta: capped.meta };
  }

  function viaPrepare(points: ChartPoint[], viz: 'line' | 'bar', kind: SeriesKind, ghost?: ChartPoint[]) {
    const out = prepareChartSeries({ points, ghost, viz, kind, unit: 'number' });
    return { values: out.values, labels: out.labels, titles: out.titles, axisLabels: out.axisLabels, ghost: out.ghost };
  }

  const pick = ({ values, labels, titles, axisLabels }: ReturnType<typeof viaPrepare>) => ({
    values,
    labels,
    titles,
    axisLabels,
  });

  describe('совпадают', () => {
    it('короткий ряд — без изменений', () => {
      const points = daily(30, (i) => (i === 4 ? null : i));
      expect(pick(viaPrepare(points, 'bar', 'flow'))).toEqual(pick(viaCap(points, 'bar', 'flow')));
    });

    it('линия без пропусков — один и тот же LTTB', () => {
      const points = daily(LONG, (i) => Math.round(Math.sin(i / 5) * 40 + i));
      expect(pick(viaPrepare(points, 'line', 'flow'))).toEqual(pick(viaCap(points, 'line', 'flow')));
    });

    it('линия с пропусками и призраком — равный шаг, призрак теми же индексами', () => {
      const points = daily(LONG, (i) => (i % 9 === 0 ? null : i));
      const ghost = daily(LONG, (i) => 500 + i, BASE - LONG * DAY_MS);
      const prepared = viaPrepare(points, 'line', 'flow', ghost);
      const capped = viaCap(points, 'line', 'flow', ghost);
      expect(pick(prepared)).toEqual(pick(capped));
      expect(prepared.ghost).toEqual(capped.ghost);
    });

    it('линия без пропусков, но с призраком — тоже равный шаг, а не LTTB: пара держит одни индексы', () => {
      const points = daily(LONG, (i) => Math.round(Math.sin(i / 5) * 40 + i));
      const ghost = daily(LONG, (i) => Math.round(Math.cos(i / 4) * 30 + 500), BASE - LONG * DAY_MS);
      const prepared = viaPrepare(points, 'line', 'flow', ghost);
      const capped = viaCap(points, 'line', 'flow', ghost);
      expect(pick(prepared)).toEqual(pick(capped));
      expect(prepared.ghost).toEqual(capped.ghost);
      const { sampledIdx } = prepareChartSeries({ points, ghost, viz: 'line', kind: 'flow', unit: 'number' });
      expect(sampledIdx).toEqual(pickIndexes(LONG, CHART_MAX_POINTS));
    });

    it('столбцы flow и stock(level) — те же недели, суммы и last-of-bucket, те же тултипы', () => {
      const points = daily(LONG, (i) => (i % 11 === 0 ? null : i));
      expect(pick(viaPrepare(points, 'bar', 'flow'))).toEqual(pick(viaCap(points, 'bar', 'flow')));
      expect(pick(viaPrepare(points, 'bar', 'stock'))).toEqual(pick(viaCap(points, 'bar', 'stock')));
    });
  });

  describe('расходятся (меняется осознанно в 3.5 и 3.9)', () => {
    it('призрак недельных столбцов: capResultSeries отбрасывает его с comparisonNote, новая политика сводит теми же неделями', () => {
      const points = daily(LONG, () => 1);
      const ghost = daily(LONG, () => 2, BASE - LONG * DAY_MS);
      const capped = viaCap(points, 'bar', 'flow', ghost);
      expect(capped.ghost).toBeNull();
      expect(capped.meta?.comparisonNote).toBe('сравнение недоступно для агрегированных недель');

      const prepared = viaPrepare(points, 'bar', 'flow', ghost);
      expect(prepared.values).toEqual(capped.values);
      expect(prepared.ghost).toEqual(new Array(LONG / 7).fill(14));
    });

    it("отношение: capResultSeries('mean') усредняет дневные средние, новая политика — Σnum/Σden", () => {
      // Чётный день — 1 пост на 100 просмотров, нечётный — 3 поста на 600.
      const points: ChartPoint[] = Array.from({ length: LONG }, (_, i) =>
        i % 2 === 0
          ? { day: dayKey(i), value: 100, num: 100, den: 1 }
          : { day: dayKey(i), value: 200, num: 600, den: 3 },
      );
      // Неделя 0: четыре дня по 100 и три по 200.
      expect(viaCap(points, 'bar', 'ratio').values[0]).toBeCloseTo((4 * 100 + 3 * 200) / 7, 10); // ≈142.9
      expect(viaPrepare(points, 'bar', 'ratio').values[0]).toBeCloseTo((4 * 100 + 3 * 600) / (4 + 3 * 3), 10); // ≈169.2
    });

    it('отношение без числителя и знаменателя (сегодняшний ряд средних): capResultSeries усредняет, новая политика — пропуск', () => {
      // Поэтому ряд средних переводится на модуль только вместе с num/den (3.5, 3.9): иначе длинные
      // столбцы вышли бы пустыми.
      const points = daily(LONG, (i) => (i % 2 === 0 ? 100 : 200));
      expect(viaCap(points, 'bar', 'ratio').values[0]).toBeCloseTo((4 * 100 + 3 * 200) / 7, 10);
      expect(viaPrepare(points, 'bar', 'ratio').values.every((v) => v === null)).toBe(true);
    });

    it('призрак другой длины: capResultSeries оставляет его как есть, новая политика не рисует вовсе', () => {
      // Короткий ряд (любой viz) capResultSeries не трогает — вместе с невыровненным призраком;
      // дальше такой призрак подгоняет alignGhost: хвост отрезается, начало добивается нулями.
      const short = daily(30, (i) => i);
      const shortGhost = daily(27, () => 5, BASE - 30 * DAY_MS);
      expect(viaCap(short, 'line', 'flow', shortGhost).ghost).toHaveLength(27);
      expect(viaPrepare(short, 'line', 'flow', shortGhost).ghost).toBeNull();
      // Длинную линию он прореживает, а призрак другой длины оставляет непрореженным.
      const long = daily(LONG, (i) => Math.round(Math.sin(i / 5) * 40 + i));
      const longGhost = daily(LONG - 3, () => 5, BASE - LONG * DAY_MS);
      const capped = viaCap(long, 'line', 'flow', longGhost);
      expect(capped.values).toHaveLength(CHART_MAX_POINTS);
      expect(capped.ghost).toHaveLength(LONG - 3);
      const prepared = viaPrepare(long, 'line', 'flow', longGhost);
      expect(prepared.values).toEqual(capped.values);
      expect(prepared.ghost).toBeNull();
    });

    it('недель больше потолка: capResultSeries остаётся на неделях, новая политика сводит в месяцы', () => {
      // 1001 день с понедельника — 143 недели > 140. При истории до 730 дней (105 недель) недостижимо.
      const points = daily(1001, () => 1);
      const capped = viaCap(points, 'bar', 'flow');
      expect(capped.values).toHaveLength(143);
      expect(capped.meta?.seriesGrain).toBe('week');
      const prepared = prepareChartSeries({ points, viz: 'bar', kind: 'flow', unit: 'number' });
      expect(prepared.grain).toBe('month');
      expect(prepared.values.length).toBeLessThanOrEqual(CHART_MAX_POINTS);
      expect(prepared.values.reduce<number>((sum, v) => sum + (v ?? 0), 0)).toBe(1001);
    });
  });
});
