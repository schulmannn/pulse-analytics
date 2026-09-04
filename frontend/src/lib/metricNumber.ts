import { fmt } from '@/lib/format';
import type { MetricUnit } from '@/lib/widgetMetrics';

/**
 * ЕДИНСТВЕННОЕ место, где решается, как печатается число метрики.
 *
 * До этого модуля одно и то же место карточки жило по трём разным правилам, и каждый источник
 * приносил своё: Telegram и Instagram звали `fmt.kpi` (сжатие от 10 000), МойСклад — `fmt.short`
 * (сжатие от 1 000, из-за чего средний чек в 2000 ₽ печатался как «2k ₽»), а СДЭК объявил
 * собственный `rub` через `fmt.num` ЧЕТЫРЕ РАЗА в четырёх файлах и показывал «1 000 000 ₽»,
 * съедавшее полкарточки. Владелец нашёл это глазами и спросил ровно то, что следовало: почему у
 * одного правила нет одного места.
 *
 * Правило (владелец): **крупное число карточки сжимается от 10 000** — «61k», а не «61 240».
 * Ниже порога число печатается полностью, потому что «6 1 2 4» человек читает как сумму, а «6.1k»
 * как оценку.
 *
 * Порог зависит не только от единицы, но и от РОЛИ числа на экране, поэтому роль — обязательный
 * аргумент, а не умолчание:
 *
 * - `headline` — крупное число карточки и плитки KPI. Сжатие от 10 000.
 * - `axis`     — подписи оси и концы столбцов. Сжатие от 1 000: там ширина колонки, а не
 *                читаемость суммы, решает, влезет ли подпись (решение владельца).
 * - `exact`    — тултипы, таблицы, экспорт. Никогда не сжимается: это места, куда идут ЗА цифрой.
 *
 * Новый источник не может «забыть» правило: единица приходит из `MetricUnit`, а строковую сборку
 * с «₽» вне этого модуля запрещает `scripts/design-motion-lint.mjs`.
 */
export type NumberRole = 'headline' | 'axis' | 'exact';

/** Порог сжатия крупного числа. Держится здесь, а не в вызывающих, чтобы менялся в одном месте. */
export const HEADLINE_COMPACT_FROM = 1e4;

/** Число без единицы измерения — по роли. */
export function formatByRole(n: number | null | undefined, role: NumberRole): string {
  if (n == null || Number.isNaN(n)) return '—';
  if (role === 'exact') return fmt.num(Math.round(n));
  if (role === 'axis') return fmt.short(n);
  return Math.abs(n) >= HEADLINE_COMPACT_FROM ? fmt.short(n) : fmt.num(Math.round(n));
}

/**
 * Рубли. Единственная сборка строки с «₽» в проекте — остальным её запрещает лint-правило
 * `money-formatted-inline`, иначе шестое объявление `rub` заведётся снова.
 */
export function formatMoney(n: number | null | undefined, role: NumberRole = 'headline'): string {
  if (n == null || Number.isNaN(n)) return '—';
  // Узкий неразрывный пробел (U+202F): раньше здесь стоял обычный, а вызывающие дописывали «₽»
  // вплотную — на одном экране жили «1.6M ₽» и «6 109₽». И перенос строки между числом и знаком
  // валюты обычный пробел не запрещает.
  return `${formatByRole(n, role)}\u202f₽`;
}

/**
 * Знаковая денежная дельта: ЛИБО стрелка, ЛИБО плюс-минус — но не оба сразу.
 *
 * Аудит #554 (D4): на /sklad печаталось «↑+99.3k ₽₽» — знак валюты дописывался поверх уже
 * готовой строки formatMoney, а стрелка ставилась поверх уже готового «+». Один форматтер
 * закрывает обе ошибки разом, и оба варианта записи остаются доступны через `arrow`.
 */
export function formatMoneyDelta(
  delta: number | null | undefined,
  { role = 'axis', arrow = false }: { role?: NumberRole; arrow?: boolean } = {},
): string {
  if (delta == null || Number.isNaN(delta)) return '—';
  const mark = arrow
    ? (delta > 0 ? '↑' : delta < 0 ? '↓' : '•')
    : (delta > 0 ? '+' : delta < 0 ? '−' : '');
  return `${mark}${formatMoney(Math.abs(delta), role)}`;
}

/**
 * Форматтер для НАБОРА чисел: регистр выбирается ОДИН раз, по наибольшему из них.
 *
 * Нужен там, где числа стоят рядом и сравниваются глазом — подписи столбцов одного графика,
 * колонка таблицы. Пер-значное решение ставит в один кадр «−8 200» и «+307.9k»: две записи одной
 * величины читаются как две разные величины (замечено на разборе «Что изменило выручку»).
 */
export function moneyFormatterFor(values: readonly number[]): (n: number) => string {
  const peak = Math.max(0, ...values.map((v) => (Number.isFinite(v) ? Math.abs(v) : 0)));
  const role: NumberRole = peak >= HEADLINE_COMPACT_FROM ? 'axis' : 'exact';
  return (n) => formatMoney(n, role);
}

/** Число метрики по её единице и роли — точка входа для панелей и конструктора виджетов. */
export function formatMetricNumber(
  n: number | null | undefined,
  unit: MetricUnit,
  role: NumberRole = 'headline',
): string {
  if (n == null || Number.isNaN(n)) return '—';
  // Проценты живут по своему правилу точности (fmt.pctAbs) и порога сжатия не имеют вовсе:
  // «12.5%» нечего сокращать, а «12k%» было бы бессмыслицей.
  if (unit === 'percent') return fmt.pctAbs(n);
  if (unit === 'currency') return formatMoney(n, role);
  return formatByRole(n, role);
}
