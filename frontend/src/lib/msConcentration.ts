// Концентрация продаж МойСклада: насколько выручка/прибыль зависит от нескольких SKU. Чистые
// расчёты Pareto-кривой вынесены сюда (а не в JSX) и покрыты юнит-тестами. Знаменатель — ВСЕГДА
// положительный итог из ответа сервера (revenue_positive_total / profit_positive_total), считаемый
// по ПОЛНОМУ raw-отчёту до limit; строки же приходят усечёнными до limit. Поэтому кривая честно
// НЕ обязана дойти до 100% (видимых строк меньше, чем товаров в отчёте) — она показывает, какую
// долю полного знаменателя дают топ-строки. Ничего не выдумываем: отрицательные/нулевые вклады
// не участвуют, знаменатель <= 0 → кривой нет.

export type ConcentrationInput = { name: string; value: number };

export type CumulativePoint = {
  /** 1-based позиция в убывающем рейтинге по метрике. */
  rank: number;
  name: string;
  /** Вклад строки в знаменатель, % (только положительный). */
  contributionPct: number;
  /** Накопленная доля топ-`rank` позиций, %, монотонно неубывающая, капнута на 100. */
  cumulativePct: number;
};

/**
 * Накопленная доля вклада топ-строк в положительном знаменателе.
 * @param rows строки со значением метрики (выручка или прибыль), в тех же единицах, что denominator.
 * @param denominator положительный итог из ответа сервера; <= 0 или не число → [] (доля недоступна).
 * @param cap максимум точек кривой (не больше числа положительных строк).
 */
export function cumulativeContribution(
  rows: ConcentrationInput[],
  denominator: number,
  cap = 50,
): CumulativePoint[] {
  if (!Number.isFinite(denominator) || denominator <= 0) return [];
  // Только положительные вклады, по убыванию: отрицательная/нулевая строка не может быть частью
  // положительной концентрации и не должна давать отрицательный или >100% сегмент.
  const positive = rows
    .filter((r) => Number.isFinite(r.value) && r.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, Math.max(0, cap));
  const out: CumulativePoint[] = [];
  let acc = 0;
  for (let i = 0; i < positive.length; i += 1) {
    const contributionPct = (positive[i].value / denominator) * 100;
    acc += contributionPct;
    out.push({
      rank: i + 1,
      name: positive[i].name,
      contributionPct,
      // Клампим на 100: суммарные вклады топ-строк не могут честно превысить полный знаменатель,
      // а копеечные расхождения округления рублей не должны рисовать 100.2%.
      cumulativePct: Math.min(100, acc),
    });
  }
  return out;
}

/** Доступный текст точки кривой для tooltip/aria: имя товара и проценты. */
export function cumulativePointLabel(p: CumulativePoint): string {
  const name = p.name || 'Без названия';
  return `${p.rank}. ${name}: +${p.contributionPct.toFixed(1)}% (накоплено ${p.cumulativePct.toFixed(1)}%)`;
}
