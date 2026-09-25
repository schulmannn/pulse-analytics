/**
 * Ряд графика: уплотнение окна, корзины по типу метрики и кап длинного ряда — ОДНОЙ политикой.
 *
 * Сегодня эту работу делают ~24 файла, и каждый по-своему: СДЭК дописывает пропущенные дни нулём,
 * IG сводит пустой день в 0, Главная отбрасывает призрак недельных столбцов и усредняет средние,
 * СДЭК прореживает призрак отдельным LTTB и сопоставляет его с чужими датами (CHARTS-5, STATES-3,
 * PERIOD-6). Модуль собирает канон, который уже живёт в `capResultSeries`
 * (lib/widgetResolver/shared), и доводит его до конца:
 *
 *  - пропуск (`null`) никогда не становится нулём — ни при уплотнении, ни в корзине, ни при
 *    прореживании; честный ноль остаётся нулём только там, где измерение было;
 *  - корзина по типу метрики: `flow` — сумма, `stock` — последнее значение корзины, `ratio` —
 *    Σчислителя / Σзнаменателя по точкам `{value, num, den}` (среднее средних запрещено);
 *  - кап до CHART_MAX_POINTS: линия без пропусков — LTTB; с пропусками или с призраком — равный
 *    шаг; призрак — ТЕМИ ЖЕ индексами; столбцы не прореживаются, а честно сводятся в календарные
 *    недели (если и недель больше потолка — в месяцы) ВМЕСТЕ с призраком;
 *  - карта `sampledIdx` (выведенная точка → индекс исходной) — и для линий, и для столбцов.
 *
 * ПОТРЕБИТЕЛЕЙ ПОКА НЕТ. Главная по-прежнему идёт через `capResultSeries`, у которого известные
 * отличия от этой политики: призрак недельных столбцов отбрасывается с comparisonNote; `mean` —
 * среднее средних (и ряд без числителя и знаменателя у него считается, а здесь — нет, см. ниже);
 * призрак другой длины он оставляет как есть; недели сверх потолка он в месяцы не сводит. Все они
 * зафиксированы тестом-снимком в chartSeries.test.ts, чтобы переключение Главной было осознанным
 * видимым шагом, а не побочным эффектом. Политика прореживания — по рекомендации OD-23; переход на
 * неё остальных поверхностей ждёт решения владельца.
 *
 * Отношение переводится на модуль только ВМЕСТЕ с числителем и знаменателем точек. Сегодняшний ряд
 * средних (bucketPostMean, средний охват) их не несёт — такая корзина из нескольких наблюдений
 * честно `null`, и длинные столбцы такого ряда вышли бы почти пустыми.
 *
 * Модуль чистый: без React, без panels/** и api/<source>. Дневные ключи `YYYY-MM-DD` — календарные
 * даты, арифметика по ним идёт в UTC и от зоны читателя не зависит; зону и «сегодня» окна выбирает
 * тот, кто строит окно (U01, OD-8), сюда приходят уже готовые границы.
 */
import { CHART_MAX_POINTS, lttbDownsample, pickIndexes } from '@/lib/downsample';
import { fmt, timeAxisFromDayKeys } from '@/lib/format';
import { DAY_MS, bucketKeyOf, bucketKeysInWindow } from '@/lib/metricSeries';
import type { SeriesGrain } from '@/lib/metricSeries';
import type { MetricUnit } from '@/lib/widgetMetrics';
import { bucketLabel, unitFormat } from '@/lib/widgetRender';

/** Тип ряда для корзин: поток (сумма), уровень (последнее значение), отношение (Σnum/Σden). */
export type SeriesKind = 'flow' | 'stock' | 'ratio';

/**
 * Точка ряда. `value: null` — ИЗМЕРЕНИЯ НЕТ (пропуск сбора или день вне выгрузки), не ноль.
 * У отношений (средний чек, средний охват, ER) точка несёт числитель и знаменатель, чтобы корзина
 * считалась Σnum/Σden, а не средним дневных средних. После `bucketSeries` в `day` лежит ключ
 * корзины (понедельник недели, `YYYY-MM`, …).
 */
export interface ChartPoint {
  day: string;
  value: number | null;
  num?: number | null;
  den?: number | null;
}

/** Окно включительных календарных дней `YYYY-MM-DD`. */
export interface DayWindow {
  from: string;
  to: string;
}

const isNum = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** Строгий дневной ключ: `Date.parse('2026-02-31')` молча уезжает в март, поэтому ключ обязан
    пережить обратное форматирование. */
function isDayKey(key: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const t = Date.parse(key);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === key;
}

export interface DensifyOptions {
  /**
   * Что значит день без точки ВНУТРИ покрытия. `'null'` — измерения не было (пропуск сбора: канал не
   * может набрать ровно ноль просмотров за сутки). `'zero'` — честный ноль арифметики архива (день
   * без заказов у МС/СДЭКа). Умолчания нет намеренно: смысл пропуска знает только источник.
   */
  missing: 'null' | 'zero';
  /**
   * Покрытие сбором или выгрузкой (конверт ответа, U02). Вне покрытия день без точки — всегда
   * `null`, даже при `missing: 'zero'`: у СДЭКа дни после последней выгрузки — это «не загружено»,
   * а не «продаж не было». Включительный диапазон (любая граница может отсутствовать) или предикат.
   */
  covered?: Partial<DayWindow> | ((day: string) => boolean);
  /** У отношения честный нулевой день — `{num: 0, den: 0}`, а само значение не определено (`null`). */
  kind?: SeriesKind;
}

function coverageTest(covered: DensifyOptions['covered']): (day: string) => boolean {
  if (covered == null) return () => true;
  if (typeof covered === 'function') return covered;
  return (day) => (covered.from == null || day >= covered.from) && (covered.to == null || day <= covered.to);
}

/**
 * Календарная сетка окна: по точке на каждый день `[from..to]`. Существующая точка остаётся как
 * есть (её `null` так и остаётся пропуском), день без точки заполняется по `missing` и `covered`.
 * `window: null` («Всё» без известных границ) — сетка по крайним дням самих точек. Точки вне окна и
 * с кривым ключом отбрасываются.
 */
export function densifyWindow(
  points: readonly ChartPoint[],
  window: DayWindow | null,
  opts: DensifyOptions,
): ChartPoint[] {
  const byDay = new Map<string, ChartPoint>();
  for (const point of points) if (isDayKey(point.day)) byDay.set(point.day, point);
  const days = [...byDay.keys()].sort();
  const from = window?.from ?? days[0];
  const to = window?.to ?? days[days.length - 1];
  if (!from || !to || !isDayKey(from) || !isDayKey(to)) return [];
  const inCoverage = coverageTest(opts.covered);
  const out: ChartPoint[] = [];
  for (let t = Date.parse(from), end = Date.parse(to); t <= end; t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    const point = byDay.get(day);
    if (point) out.push(point);
    else if (opts.missing === 'zero' && inCoverage(day)) {
      out.push(opts.kind === 'ratio' ? { day, value: null, num: 0, den: 0 } : { day, value: 0 });
    } else out.push({ day, value: null });
  }
  return out;
}

/**
 * Свёртка точек одной корзины по типу. Точки — в хронологическом порядке (важно для `stock`).
 *
 * Пропуск в корзине не участвует: для `flow` он не прибавляет ноль, для `stock` не становится
 * «последним значением». Корзина, где ВСЕ точки — пропуск, сама остаётся пропуском.
 *
 * `ratio`: если у всех наблюдений есть числитель и знаменатель — Σnum/Σden (Σden = 0 → значение не
 * определено, `null`). Точка без них — отношение с неизвестным весом. Одна такая точка — само себе
 * отношение, если остальные точки корзины в суммы ничего не вносят: пропуск или честный нулевой
 * день уплотнения `{num: 0, den: 0}` (иначе ответ зависел бы от того, чем залиты дыры). Несколько
 * точек без числителя и знаменателя или такая точка рядом с весомой честно сложить нельзя (среднее
 * средних — ровно та ошибка, которую модуль убирает), поэтому корзина — `null`, а не выдуманное число.
 */
function aggregateBucket(points: readonly ChartPoint[], kind: SeriesKind): Omit<ChartPoint, 'day'> {
  if (kind === 'flow') {
    let sum: number | null = null;
    for (const point of points) if (isNum(point.value)) sum = (sum ?? 0) + point.value;
    return { value: sum };
  }
  if (kind === 'stock') {
    let last: number | null = null;
    for (const point of points) if (isNum(point.value)) last = point.value;
    return { value: last };
  }
  const hasParts = (point: ChartPoint) => isNum(point.num) && isNum(point.den);
  const observed = points.filter((point) => isNum(point.value) || hasParts(point));
  if (observed.length === 0) return { value: null };
  if (observed.every(hasParts)) {
    let num = 0;
    let den = 0;
    for (const point of observed) {
      num += point.num as number;
      den += point.den as number;
    }
    return { value: den > 0 ? num / den : null, num, den };
  }
  const weighed = observed.filter((point) => !(hasParts(point) && point.num === 0 && point.den === 0));
  if (weighed.length === 1) return { value: isNum(weighed[0].value) ? weighed[0].value : null };
  return { value: null };
}

/**
 * Дневной ряд → корзины `grain` по типу метрики. Ключи корзин — те же, что у резолвера виджетов
 * (`bucketKeyOf`: понедельник недели, `YYYY-MM`, `YYYY-Qn`, `YYYY`). С окном возвращается КАЖДАЯ
 * корзина окна (пустая — `null`, то есть пропуск); без окна — только корзины, где есть точки.
 * Точки вне окна отбрасываются, как у `densifyWindow`: крайняя неполная неделя или месяц окна не
 * подбирает соседние дни (у `stock` день после `to` стал бы «последним», у `flow` — прибавился бы).
 */
export function bucketSeries(
  points: readonly ChartPoint[],
  window: DayWindow | null,
  grain: SeriesGrain,
  kind: SeriesKind,
): ChartPoint[] {
  const bounds = window && isDayKey(window.from) && isDayKey(window.to) ? window : null;
  const inWindow = (day: string) => !bounds || (day >= bounds.from && day <= bounds.to);
  const groups = new Map<string, ChartPoint[]>();
  const sorted = points
    .filter((point) => isDayKey(point.day) && inWindow(point.day))
    .sort((a, b) => a.day.localeCompare(b.day));
  for (const point of sorted) {
    const key = bucketKeyOf(Date.parse(point.day), grain);
    const group = groups.get(key);
    if (group) group.push(point);
    else groups.set(key, [point]);
  }
  const keys = bounds
    ? bucketKeysInWindow(Date.parse(bounds.from), Date.parse(bounds.to), grain)
    : [...groups.keys()].sort();
  return keys.map((key) => ({ day: key, ...aggregateBucket(groups.get(key) ?? [], kind) }));
}

export interface PrepareChartSeriesInput {
  /** Ряд в хронологическом порядке, уже уплотнённый (`densifyWindow`) — индекс точки = позиция по X. */
  points: readonly ChartPoint[];
  /**
   * Призрак сравнения, выровненный ПО ИНДЕКСАМ с `points` (i-я точка призрака — пара i-й точки ряда,
   * со СВОЕЙ настоящей датой). Призрак другой длины не рисуется вовсе: подгонять его хвостом или
   * нулями значило бы сопоставить значения с чужими датами.
   */
  ghost?: readonly ChartPoint[] | null;
  viz: 'line' | 'bar';
  kind: SeriesKind;
  unit: MetricUnit;
  /** Грануляция входного ряда. По умолчанию `day`. */
  grain?: SeriesGrain;
  maxPoints?: number;
}

export interface PreparedChartSeries {
  /** `null` — пропуск: линия рвётся, столбец не рисуется. */
  values: Array<number | null>;
  /** Призрак, выровненный с `values`; `null` — призрака нет (не передан или не выровнен). */
  ghost: Array<number | null> | null;
  labels: string[];
  /** Ось по канону timeAxisCore; `undefined` — ось остаётся датами. */
  axisLabels?: string[];
  titles: string[];
  ghostTitles: string[] | null;
  /**
   * Выведенная точка k → индекс исходной точки. Для линий — сама выбранная точка; для сведённых
   * столбцов — ПЕРВАЯ точка корзины: корзина k покрывает исходные `[sampledIdx[k], sampledIdx[k+1])`.
   */
  sampledIdx: number[];
  /** Грануляция выведенного ряда (`week`, если длинные столбцы сведены в недели). */
  grain: SeriesGrain;
}

const COARSER: SeriesGrain[] = ['day', 'week', 'month', 'quarter', 'year'];

/** Группы подряд идущих точек одной корзины для ближайшей грануляции, при которой столбцов не больше
    потолка. `null` — свести нельзя (кривой ключ или грубее некуда): столбцы тогда остаются как есть. */
function barGroups(
  points: readonly ChartPoint[],
  grain: SeriesGrain,
  max: number,
): { grain: SeriesGrain; keys: string[]; starts: number[] } | null {
  for (let g = COARSER.indexOf(grain) + 1; g > 0 && g < COARSER.length; g += 1) {
    const target = COARSER[g];
    const keys: string[] = [];
    const starts: number[] = [];
    for (let i = 0; i < points.length; i += 1) {
      const t = Date.parse(points[i].day);
      if (!Number.isFinite(t)) return null;
      const key = bucketKeyOf(t, target);
      if (keys[keys.length - 1] !== key) {
        keys.push(key);
        starts.push(i);
      }
    }
    if (keys.length <= max || g === COARSER.length - 1) return { grain: target, keys, starts };
  }
  return null;
}

const pointValue = (point: ChartPoint | undefined): number | null => (point && isNum(point.value) ? point.value : null);

/**
 * Точки ряда и призрака → готовые серии для графикового примитива.
 *
 * Хедлайн, дельту и статистику считает вызывающий от ПОЛНОГО ряда до этого шага — кап меняет только
 * плотность точек графика.
 */
export function prepareChartSeries(input: PrepareChartSeriesInput): PreparedChartSeries {
  const { points, viz, kind, unit } = input;
  const max = input.maxPoints ?? CHART_MAX_POINTS;
  const n = points.length;
  const ghostIn = input.ghost && input.ghost.length === n ? input.ghost : null;

  let grain: SeriesGrain = input.grain ?? 'day';
  let rendered: ChartPoint[];
  let ghostRendered: Array<number | null> | null = null;
  // Настоящие дни точки призрака (у сведённой корзины — первый и последний).
  let ghostSpans: Array<{ from: string; to: string }> | null = null;
  let sampledIdx: number[];

  const groups = viz === 'bar' && n > max ? barGroups(points, grain, max) : null;
  if (groups) {
    grain = groups.grain;
    sampledIdx = groups.starts;
    const ends = [...groups.starts.slice(1), n];
    rendered = groups.keys.map((key, k) => ({
      day: key,
      ...aggregateBucket(points.slice(groups.starts[k], ends[k]), kind),
    }));
    if (ghostIn) {
      ghostRendered = groups.starts.map((start, k) => aggregateBucket(ghostIn.slice(start, ends[k]), kind).value);
      ghostSpans = groups.starts.map((start, k) => ({ from: ghostIn[start].day, to: ghostIn[ends[k] - 1].day }));
    }
  } else {
    if (n <= max || viz === 'bar') {
      // Короткий ряд не трогается; длинные столбцы, которые свести нельзя, — тоже: прореженные
      // столбцы врут пропущенными днями.
      sampledIdx = Array.from({ length: n }, (_, i) => i);
    } else if (ghostIn || points.some((point) => !isNum(point.value))) {
      // LTTB выбирает точки по площади треугольников и требует число в каждой; пропуск пришлось бы
      // чем-то заменить. И для пары линий он выбрал бы каждой свои индексы. Равный шаг сохраняет и
      // позиции разрывов, и выравнивание призрака.
      sampledIdx = pickIndexes(n, max);
    } else {
      sampledIdx = lttbDownsample(
        Array.from({ length: n }, (_, i) => i),
        max,
        (i) => points[i].value as number,
      );
    }
    rendered = sampledIdx.map((i) => points[i]);
    if (ghostIn) {
      ghostRendered = sampledIdx.map((i) => pointValue(ghostIn[i]));
      ghostSpans = sampledIdx.map((i) => ({ from: ghostIn[i].day, to: ghostIn[i].day }));
    }
  }

  const format = unitFormat(unit);
  // Дата недельной корзины — её понедельник: без « · неделя» тултип читался бы как один день.
  const suffix = grain === 'week' ? ' · неделя' : '';
  const values = rendered.map((point) => pointValue(point));
  const labels = rendered.map((point) => bucketLabel(point.day));
  const titles = values.map((v, k) => (v == null ? `${labels[k]}: данных нет` : `${labels[k]}: ${format(v)}${suffix}`));
  // Точка призрака подписывается СВОИМИ днями. Сведённая корзина призрака — не календарная неделя
  // (прошлое окно сдвинуто на произвольное число дней), поэтому у неё диапазон, а не «понедельник».
  const spans = ghostSpans;
  const ghostTitles =
    ghostRendered && spans
      ? ghostRendered.map((v, k) => {
          const { from, to } = spans[k];
          const label = !groups ? bucketLabel(from) : from === to ? fmt.day(from) : `${fmt.day(from)} – ${fmt.day(to)}`;
          return v == null ? `${label}: данных нет` : `${label}: ${format(v)}${groups ? '' : suffix}`;
        })
      : null;
  const axisLabels = timeAxisFromDayKeys(
    rendered.map((point) => point.day),
    { monthsOnly: grain === 'week' },
  );
  return { values, ghost: ghostRendered, labels, axisLabels, titles, ghostTitles, sampledIdx, grain };
}
