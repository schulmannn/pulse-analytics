/**
 * Домен компактной искры, устойчивый к выбросу.
 *
 * Зачем: min–max отдаёт всю высоту одному вирусному дню. На проде у «Реакций» пик был в 8.2 раза
 * выше медианы — 90% точек прижимались ко дну плота, и месяц выглядел плоской чертой. Логарифм на
 * искре БЕЗ подписанной оси проект считает ложью, поэтому шкала остаётся линейной, а меняется
 * только ОКНО ПРОСМОТРА: домен режется по квантилям, а то, что вышло за край, отмечается каре́ткой
 * и показывает настоящее число в ховер-читалке (Observable Plot: «Clamped values may need an
 * annotation to avoid misinterpretation»).
 *
 * Данные НЕ винзоризуются — режется только домен. Иначе тултип и хедлайн карточки разошлись бы.
 *
 * Клип включается лишь когда он что-то чинит: нужен и заметный выброс (пик выше медианы в
 * OUTLIER_RATIO раз), и достаточная выборка. На коротком окне (7–14 дней) выброс — это и есть
 * сюжет, а не помеха, поэтому там домен остаётся честным min–max.
 */
export const OUTLIER_RATIO = 4;
export const MIN_POINTS_FOR_CLIP = 12;
const UPPER_Q = 0.95;

export interface SparkDomain {
  min: number;
  max: number;
  /** Индексы точек, вышедших за верхнюю границу — рендер помечает их карéткой. */
  clipped: number[];
}

function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * @param values только НАБЛЮДЕНИЯ (пропуски отфильтрованы вызывающим — они не участвуют ни в
 *        квантилях, ни в домене).
 */
export function sparkDomain(values: number[]): SparkDomain {
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  if (values.length < MIN_POINTS_FOR_CLIP) return { min, max, clipped: [] };

  const sorted = [...values].sort((a, b) => a - b);
  const median = quantileSorted(sorted, 0.5);
  // Медиана 0 (больше половины дней без событий) — отношение не определено, клипать нечего.
  if (median <= 0 || max < median * OUTLIER_RATIO) return { min, max, clipped: [] };

  const upper = quantileSorted(sorted, UPPER_Q);
  // Квантиль совпал с максимумом (плато наверху) — клип ничего не откроет, только соврёт.
  if (!(upper > min) || upper >= max) return { min, max, clipped: [] };

  const clipped: number[] = [];
  values.forEach((value, index) => {
    if (value > upper) clipped.push(index);
  });
  return { min, max: upper, clipped };
}
