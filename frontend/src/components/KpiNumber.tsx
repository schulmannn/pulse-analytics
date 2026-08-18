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

/** WAAPI-таймингам NumberFlow нужны JS-значения, а канон запрещает инлайнить кривую — поэтому
    токены моторики (--ease-standard, --motion-morph, --motion-fast) читаются из computed style:
    единственный источник остаётся в index.css. Парсер длительности понимает обе формы записи —
    минификатор превращает '700ms' в '.7s' (грабля морф-волны #406). SSR/jsdom — статичный
    фолбэк, на клиенте значения кэшируются при первом рендере. */
function parseDurationMs(raw: string, fallback: number): number {
  const v = raw.trim();
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return v.endsWith('ms') ? n : n * 1000;
}

interface HouseTimings {
  morph: { duration: number; easing: string };
  fade: { duration: number; easing: string };
}

let cachedTimings: HouseTimings | null = null;

function houseTimings(): HouseTimings {
  if (cachedTimings) return cachedTimings;
  const fallback: HouseTimings = {
    morph: { duration: 700, easing: 'ease' },
    fade: { duration: 200, easing: 'ease' },
  };
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback;
  const style = getComputedStyle(document.documentElement);
  const easing = style.getPropertyValue('--ease-standard').trim() || fallback.morph.easing;
  cachedTimings = {
    morph: { duration: parseDurationMs(style.getPropertyValue('--motion-morph'), 700), easing },
    fade: { duration: parseDurationMs(style.getPropertyValue('--motion-fast'), 200), easing },
  };
  return cachedTimings;
}

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
  const timings = houseTimings();
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
          transformTiming={timings.morph}
          spinTiming={timings.morph}
          opacityTiming={timings.fade}
        />
        {suffixSpan}
      </Suspense>
    </span>
  );
}
