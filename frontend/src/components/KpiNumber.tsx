import { Suspense, lazy, useMemo } from 'react';
import { ValueSwap } from '@/components/ValueSwap';
import { cn } from '@/lib/utils';

/** Ленивый чанк (грабля #451: статический импорт зависимости валит bundle-бюджеты ВСЕХ
    роут-групп разом — check-bundle-size ходит по статическому графу). До подгрузки Suspense
    держит статичное число тех же глифов — визуально бесшовно, морф просто «включается». */
const NumberFlow = lazy(() => import('@number-flow/react'));

/**
 * Цифровой морф KPI-числа (канон моторики, решение владельца 2026-08-18: числовой хедлайн
 * догоняет морф графиков; прежний снап-канон 2026-07-28 остаётся у нечисловых строк).
 * Значение приходит УЖЕ отформатированной строкой домашних форматтеров — компонент разбирает её
 * на числовое ядро и текстовый суффикс и анимирует только цифры через @number-flow/react
 * (dependency-free, уважает prefers-reduced-motion сам). Строка, которую разобрать нельзя
 * (даты, «—», «<0.1%», минус U+2212), рендерится прежним ValueSwap — поведение не меняется.
 */

/** Тайминги зеркалят токены моторики: --motion-morph (700ms) и --ease-standard из index.css /
    design-motion-lint HOUSE_CURVE. Правка кривой или длительности обязана менять все места
    синхронно — см. канон Ковальски. */
const MORPH_TIMING = { duration: 700, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' } as const;
const FADE_TIMING = { duration: 200, easing: 'ease-out' } as const;

/** Разделители разрядов домашних строк: пробел, NBSP (toLocaleString('ru-RU')), узкий NBSP. */
const GROUP_SEP = /[   ]/;
const GROUP_SEP_ALL = /[   ]/g;
const KPI_TEXT = /^([+-]?)((?:\d{1,3}(?:[   ]\d{3})+|\d+)(?:\.(\d+))?)([^\d]*)$/;

export interface ParsedKpiText {
  /** Числовое значение со знаком ('-' допустим, '−' U+2212 — нет). */
  value: number;
  /** Явный «+» в строке («+12.6k») → Intl signDisplay: 'always'. */
  plus: boolean;
  /** Точное число знаков после точки в исходной строке — Intl обязан отдать те же цифры. */
  fractionDigits: number;
  /** В строке была группировка разрядов → локаль ru-RU. */
  grouped: boolean;
  /** Текстовый хвост («k», «%», « ₽», …) — рендерится статичным спаном, не анимируется. */
  suffix: string;
}

/**
 * Разбор строки домашних форматтеров (fmt.kpi/num/short/pctAbs, fmtMetric) на число + суффикс:
 * «12.6k» → 12.6 + «k», «4 749» → 4749 (grouped), «28.9%» → 28.9 + «%», «+3 210» → плюс.
 * null — строка не «число с суффиксом» и обязана остаться на снапе ValueSwap. Гварды честности:
 * суффикс без цифр (дата «5 июн.» не анимируется), группировка несовместима с дробью (такую
 * строку домашние форматтеры не производят — а Intl отдал бы запятую вместо точки).
 */
export function parseKpiText(text: string): ParsedKpiText | null {
  const m = KPI_TEXT.exec(text);
  if (!m) return null;
  const [, sign, core, frac = '', suffix] = m;
  const grouped = GROUP_SEP.test(core);
  if (grouped && frac.length > 0) return null;
  const value = Number((sign === '-' ? '-' : '') + core.replace(GROUP_SEP_ALL, ''));
  if (!Number.isFinite(value)) return null;
  return { value, plus: sign === '+', fractionDigits: frac.length, grouped, suffix };
}

/**
 * Drop-in замена `<ValueSwap swapKey={text}>{text}</ValueSwap>` для числовых хедлайнов.
 * `unitClassName` стилизует суффикс отдельно (тихий юнит StatTile); без него суффикс наследует
 * стиль числа — посимвольный паритет со старым рендером в обоих случаях.
 */
export function KpiNumber({
  text,
  className,
  unitClassName,
}: {
  text: string;
  className?: string;
  unitClassName?: string;
}) {
  const parsed = useMemo(() => parseKpiText(text), [text]);
  if (!parsed) {
    return (
      <ValueSwap swapKey={text} className={className}>
        {text}
      </ValueSwap>
    );
  }
  // Ядро без суффикса — для статичного фолбэка Suspense (те же символы, что отдаст NumberFlow).
  const core = text.slice(0, text.length - parsed.suffix.length);
  const suffixSpan = parsed.suffix ? <span className={unitClassName}>{parsed.suffix}</span> : null;
  return (
    <span className={cn('inline-flex items-baseline', className)}>
      <Suspense
        fallback={
          <>
            <span>{core}</span>
            {suffixSpan}
          </>
        }
      >
        <NumberFlow
          value={parsed.value}
          // Локаль повторяет символы источника: группировка ru-RU (NBSP, как в fmt.num), дробь —
          // точка en-US (мантисса fmt.short / проценты). Обе строки собирает тот же Intl движка.
          locales={parsed.grouped ? 'ru-RU' : 'en-US'}
          format={{
            useGrouping: parsed.grouped,
            minimumFractionDigits: parsed.fractionDigits,
            maximumFractionDigits: parsed.fractionDigits,
            ...(parsed.plus ? { signDisplay: 'always' as const } : null),
          }}
          transformTiming={MORPH_TIMING}
          spinTiming={MORPH_TIMING}
          opacityTiming={FADE_TIMING}
        />
        {suffixSpan}
      </Suspense>
    </span>
  );
}
