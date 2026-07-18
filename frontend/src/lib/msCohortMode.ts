/**
 * Pure cohort-cell math for the MoySklad cohort matrix.
 *
 * Три честных режима, все нормированные на ИСХОДНЫЙ размер когорты (size, а не активных на offset) —
 * это и делает когорты разного размера сравнимыми:
 *   • retention — доля активных клиентов (active / size), значение 0..1 (доля, не деньги);
 *   • revenue   — выручка заказов offset-месяца на одного исходного клиента (₽), помесячно;
 *   • ltv       — накопленная выручка offset 0..N на одного исходного клиента (₽), кумулятивно.
 *
 * Деньги приходят из API уже в рублях (граница конвертирует копейки). Отрицательные суммы и ноль
 * остаются как есть — ничего не выдумываем. Будущие/отсутствующие offset-клетки решает вызывающий
 * (пустая клетка), эта функция считает только значение при наличии данных.
 */

export type MsCohortMode = 'retention' | 'revenue' | 'ltv';

export const MS_COHORT_MODES: readonly MsCohortMode[] = ['retention', 'revenue', 'ltv'] as const;

export interface MsCohortCell {
  offset: number;
  active: number;
  revenue: number | null;
}

/**
 * Значение одной клетки когорты в выбранном режиме, либо null если считать не от чего
 * (пустая когорта size ≤ 0). Кумулятив LTV берёт отсутствующие offset-клетки за 0 —
 * плотная сетка репо гарантирует, что дырок внутри горизонта нет, но месяц без заказов
 * (revenue 0) корректно не добавляет к сумме.
 */
export function cohortCellValue(
  cells: readonly MsCohortCell[],
  size: number,
  offset: number,
  mode: MsCohortMode,
): number | null {
  if (size <= 0) return null;
  const byOffset = new Map(cells.map((cell) => [cell.offset, cell]));
  if (mode === 'retention') return (byOffset.get(offset)?.active ?? 0) / size;
  if (mode === 'revenue') {
    const cell = byOffset.get(offset);
    return cell?.revenue === null ? null : (cell?.revenue ?? 0) / size;
  }
  let cumulative = 0;
  for (let o = 0; o <= offset; o++) {
    const cell = byOffset.get(o);
    if (cell?.revenue === null) return null;
    cumulative += cell?.revenue ?? 0;
  }
  return cumulative / size;
}

/** true для денежных режимов (₽), false для retention (доля/проценты). */
export function isMoneyCohortMode(mode: MsCohortMode): boolean {
  return mode === 'revenue' || mode === 'ltv';
}
