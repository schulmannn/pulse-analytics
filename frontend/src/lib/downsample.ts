/**
 * Largest-Triangle-Three-Buckets downsampling. Keeps the visual shape of a long series
 * (and its first/last points) while cutting it to `threshold` points — so long history
 * charts stay crisp instead of blurring into a wall of pixels. Returns a SUBSET of the
 * original rows, so parallel label/tooltip arrays stay aligned. No-op when small.
 */
export function lttbDownsample<T>(rows: T[], threshold: number, valueOf: (r: T) => number): T[] {
  const n = rows.length;
  if (threshold >= n || threshold < 3) return rows;
  const sampled: T[] = [rows[0]];
  const every = (n - 2) / (threshold - 2);
  let a = 0;
  for (let i = 0; i < threshold - 2; i++) {
    let avgX = 0, avgY = 0, cnt = 0;
    const rangeStart = Math.floor((i + 1) * every) + 1;
    const rangeEnd = Math.min(Math.floor((i + 2) * every) + 1, n);
    for (let j = rangeStart; j < rangeEnd; j++) { avgX += j; avgY += valueOf(rows[j]); cnt++; }
    avgX /= cnt || 1; avgY /= cnt || 1;
    const curStart = Math.floor(i * every) + 1;
    const curEnd = Math.floor((i + 1) * every) + 1;
    const ay = valueOf(rows[a]);
    let maxArea = -1, next = curStart;
    for (let j = curStart; j < curEnd; j++) {
      const area = Math.abs((a - avgX) * (valueOf(rows[j]) - ay) - (a - j) * (avgY - ay)) * 0.5;
      if (area > maxArea) { maxArea = area; next = j; }
    }
    sampled.push(rows[next]); a = next;
  }
  sampled.push(rows[n - 1]);
  return sampled;
}

/**
 * Индексы прореживания РАВНЫМ ШАГОМ (+ всегда последняя точка). В отличие от LTTB не смотрит на
 * значения, поэтому годится там, где LTTB врёт: у ряда с пропусками (площадь треугольника с null
 * не посчитать — разрыв либо исчез бы, либо провалился в ноль) и у пары «ряд + призрак» (LTTB
 * выбрал бы каждой линии свои индексы и рассинхронизировал их по X).
 *
 * Жил в `lib/msSeries` (схема та же, что у его `strideEvery`); переехал к LTTB, потому что его
 * зовут резолвер виджетов, упоминания, страница метрики TG и `lib/chartSeries`, а модуль МС тянет
 * за собой `msPeriod` с React.
 */
export function pickIndexes(total: number, max: number): number[] {
  if (total <= max) return Array.from({ length: total }, (_, i) => i);
  const step = Math.ceil(total / max);
  const out: number[] = [];
  for (let i = 0; i < total; i += step) out.push(i);
  if (out[out.length - 1] !== total - 1) out.push(total - 1);
  return out;
}

/**
 * Потолок точек графика — ОБЩИЙ для всех сетей (канон CLAUDE.md: серии длиннее прореживаются до
 * рендера, иначе суб-пиксельная мазня и дорогие кадры морфа).
 *
 * Жил в `lib/msSeries` — модуле МойСклада, — хотя его импортируют девятнадцать файлов всех шести
 * источников: TG, IG, упоминания, СДЭК, Rusender, кампании и резолвер виджетов. Константа,
 * управляющая КАЖДЫМ графиком продукта, переехала туда, где живёт сам алгоритм прореживания.
 */
export const CHART_MAX_POINTS = 140;
