import { fmt } from '@/lib/format';
import { msDensifyWindow, type MsPeriod } from '@/lib/msPeriod';

/**
 * Общие чистые помощники дневных серий МойСклада — одна реализация densify → bucket → stride и
 * метрик (выручка / заказы / средний чек) для «Каналов» и «Обзора». Держим их отдельно от панелей,
 * чтобы график каналов и explorer'ы обзора считали бакеты и sparse-средний чек ОДИНАКОВО, и чтобы
 * логику можно было покрыть юнит-тестами без рендера.
 */

export type Metric = 'revenue' | 'orders' | 'aov';
export type Grain = 'day' | 'week' | 'month';
/** День архива: `orders` — число заказов, `sum` — выручка/сумма заказов в рублях (уже с бэка). */
export type DayPoint = { day: string; orders: number; sum: number };

export const METRIC_LABEL: Record<Metric, string> = {
  revenue: 'Выручка',
  orders: 'Заказы',
  aov: 'Средний чек',
};

/** Русское слово бакета грануляции — для честной подписи среднего чека «по … с заказами». */
export const GRAIN_BUCKET_WORD: Record<Grain, string> = { day: 'дням', week: 'неделям', month: 'месяцам' };

/** Максимум точек графика (канон CLAUDE.md: длинные серии прореживаются до рендера). */
export const CHART_MAX_POINTS = 140;

/** Значение метрики точки: средний чек честно null в бакет без заказов (деление на ноль = ложь). */
export function metricValue(metric: Metric, p: { orders: number; sum: number }): number | null {
  if (metric === 'revenue') return p.sum;
  if (metric === 'orders') return p.orders;
  return p.orders > 0 ? p.sum / p.orders : null;
}

/** Формат значения метрики для тултипа/числа. */
export function fmtMetric(metric: Metric, v: number | null): string {
  if (v == null) return '—';
  return metric === 'orders' ? fmt.num(v) : `${fmt.short(v)} ₽`;
}

export const localDayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const dayToDate = (key: string): Date => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/** Календарная сетка окна нулями (бэк отдаёт только дни с заказами) — арифметика по архиву, не
    пропуск сбора: день без заказов = честный ноль (для среднего чека — производный null). */
export function densifyDayPoints(series: DayPoint[], period: MsPeriod, firstDayOverride?: string): DayPoint[] {
  const win = msDensifyWindow(period, firstDayOverride ?? series[0]?.day);
  if (!win) return series;
  const byDay = new Map(series.map((r) => [r.day, r]));
  const out: DayPoint[] = [];
  for (const d = new Date(win.start); d <= win.end; d.setDate(d.getDate() + 1)) {
    const key = localDayKey(d);
    const r = byDay.get(key);
    out.push({ day: key, orders: r?.orders ?? 0, sum: r?.sum ?? 0 });
  }
  return out;
}

/** Грануляция дневной серии в неделю/месяц (сумма заказов/выручки; средний чек — производное на
    границе бакета: sum(выручка)/sum(заказы), НЕ среднее дневных чеков). */
export function bucketPoints(points: DayPoint[], grain: Grain): DayPoint[] {
  if (grain === 'day') return points;
  const key = (day: string) => {
    if (grain === 'month') return `${day.slice(0, 7)}-01`;
    const d = dayToDate(day);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // к понедельнику недели
    return localDayKey(d);
  };
  const map = new Map<string, DayPoint>();
  for (const p of points) {
    const k = key(p.day);
    const cur = map.get(k) ?? { day: k, orders: 0, sum: 0 };
    cur.orders += p.orders;
    cur.sum += p.sum;
    map.set(k, cur);
  }
  return [...map.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** Прореживание с сохранением выравнивания по X (равномерный шаг + последняя точка). LTTB не
    годится для мультисерий: он выбирал бы разные индексы для каждой линии → рассинхрон оси. */
export function strideEvery<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = Math.ceil(arr.length / max);
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[i]);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

/** Индексы прореживания, согласованные с strideEvery (та же схема шага), чтобы X совпадал у линий. */
export function pickIndexes(total: number, max: number): number[] {
  if (total <= max) return Array.from({ length: total }, (_, i) => i);
  const step = Math.ceil(total / max);
  const out: number[] = [];
  for (let i = 0; i < total; i += step) out.push(i);
  if (out[out.length - 1] !== total - 1) out.push(total - 1);
  return out;
}

/**
 * Точки для АГРЕГАТНОЙ линии/столбцов одной метрики. Для выручки/заказов — вся дозаполненная сетка
 * (честные нули непрерывной линией). Для среднего чека — ТОЛЬКО бакеты с заказами: день без заказов
 * даёт неопределённый чек (null), а общий LineChart трактует null как пропуск сбора и рвёт линию в
 * россыпь одиночных точек. Отфильтровав пустые бакеты ДО рендера, рисуем непрерывный ряд НАБЛЮДЕНИЙ
 * (по бакетам с заказами), сохраняя настоящие даты. Порядок важен: сначала densify+bucket, затем
 * фильтр и только потом прореживание.
 */
export function aggregatePlotPoints(bucketed: DayPoint[], metric: Metric, maxPoints: number): DayPoint[] {
  const relevant = metric === 'aov' ? bucketed.filter((p) => p.orders > 0) : bucketed;
  return strideEvery(relevant, maxPoints);
}

/** Итог метрики за окно: выручка/заказы — сумма, средний чек — sum(выручка)/sum(заказы) по всем
    бакетам с заказами (НЕ среднее дневных чеков). Возвращает null для среднего чека без заказов. */
export function metricTotal(series: DayPoint[], metric: Metric): number | null {
  if (metric === 'aov') {
    const sum = series.reduce((a, p) => a + p.sum, 0);
    const orders = series.reduce((a, p) => a + p.orders, 0);
    return orders > 0 ? sum / orders : null;
  }
  return series.reduce((a, p) => a + (metric === 'revenue' ? p.sum : p.orders), 0);
}
