// «Значение · доля» для разбивок, являющихся ЧАСТЯМИ ЦЕЛОГО (источники просмотров/подписчиков,
// языки, тональность, реакции по эмодзи, состав вовлечённости, просмотры по форматам).
// Канон подачи — легенда круговой и строки IG-аудитории: «1 310 · 54.3%», до одного знака после
// запятой; целые доли печатаются без «.0» («1 310 · 71%»).
//
// ГЛАВНОЕ ПРАВИЛО: доля считается от ПОЛНОЙ суммы разбивки — ДО среза топ-N (языки и эмодзи
// режутся `slice(0, 8)`), иначе доли врут: показанные строки дали бы ровно 100%, а скрытый хвост
// исчез бы из картины. Поэтому `withShares` вызывается на ПОЛНОМ списке, а `slice` — уже после
// него; сумма долей видимых строк тогда честно меньше 100% на величину хвоста.
//
// Средние и коэффициенты («Ср. охват по типу», ERV по формату) долей НЕ получают — это не части
// целого, их сумма ничего не значит.

/** Строка разбивки в терминах доли. */
export interface ShareableItem {
  value: number;
}

/** Сумма положительных значений разбивки — знаменатель долей. */
export function breakdownTotal(items: readonly ShareableItem[]): number {
  return items.reduce(
    (sum, item) => sum + (Number.isFinite(item.value) && item.value > 0 ? item.value : 0),
    0,
  );
}

/**
 * Проставляет строкам `share` (0..1) от полной суммы разбивки. `total` задаётся явно, когда
 * знаменатель известен снаружи (например, список уже урезан вызывающим кодом). Пустой/нулевой
 * знаменатель оставляет строки без доли — печатать «0%» там было бы враньём.
 */
export function withShares<T extends ShareableItem>(
  items: T[],
  total?: number,
): Array<T & { share?: number }> {
  const denom = total ?? breakdownTotal(items);
  if (!(denom > 0)) return items.map((item) => ({ ...item }));
  return items.map((item) => ({
    ...item,
    share: item.value > 0 ? item.value / denom : 0,
  }));
}

/**
 * «54.3%» — формат легенды круговой; доли меньше 0.1% не схлопываются в бессмысленный «0.0%».
 * Целая доля печатается без хвостовой «.0»: «71%» и «100%», а не «71.0%»/«100.0%» — лишний знак
 * читался как шум там, где точность ничего не добавляет (владелец, приёмка волны).
 */
export function formatShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%';
  const pct = share * 100;
  if (pct < 0.1) return '<0.1%';
  const rounded = Math.round(pct * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

/** «1 310 · 54.3%» — значение с долей; строка без доли остаётся как есть. */
export function displayWithShare(display: string, share?: number): string {
  return share == null ? display : `${display} · ${formatShare(share)}`;
}
