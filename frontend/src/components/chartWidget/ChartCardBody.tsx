import { useContext, type ReactNode } from 'react';
import { KpiValue } from '@/components/chartWidget/KpiValue';
import { DeltaPill } from '@/components/DeltaPill';
import type { DeltaBasis } from '@/components/DeltaPill';
import { ChartCardTitleContext, ChartExpandedContext } from '@/components/ExpandableChart';
import { fmt } from '@/lib/format';
import { useWidgetSize } from '@/lib/widgetSize';
import type { MetricDelta } from '@/lib/delta';

/** Мин/макс видимого окна для строки-сводки карточки. По умолчанию — регистр fmt.kpi (тот же,
    что у леджера разворота OverlayStats); денежные/процентные карточки передают свой format. */
export interface RangeSummary {
  lo: number;
  hi: number;
  format?: (n: number) => string;
}

/** {lo, hi} потоковой серии для `range` — от СЫРОГО окна (до LTTB-капа), null-пропуски
    отбрасываются. Меньше двух точек — сводки нет. Кумулятивным уровням (подписчики) range
    не передавать: их мин/макс дублирует концы ряда. */
export function seriesRange(
  values: ReadonlyArray<number | null | undefined> | null | undefined,
): { lo: number; hi: number } | null {
  const nums = (values ?? []).filter((v): v is number => v != null && Number.isFinite(v));
  if (nums.length < 2) return null;
  return { lo: Math.min(...nums), hi: Math.max(...nums) };
}

export interface ChartCardBodyProps {
  label?: ReactNode;
  value: string;
  delta?: MetricDelta | null;
  /** С чем сравнена `delta` — даты базы и её число. Герой-карточка — единственное место, где
      пилюля стоит ОТДЕЛЬНОЙ строкой, а не рядом с числом, поэтому основание идёт своим пропом. */
  deltaBasis?: DeltaBasis | null;
  /** Мин/макс окна под DeltaPill — вынос леджера разворота на лицо карточки (владелец
      2026-08-18, «hi/lo chrome»). Только ≥ md: структурная строка, мобильную вёрстку не меняем. */
  range?: RangeSummary | null;
  caption?: ReactNode;
  onValueClick?: () => void;
  /** Accessible metric name for the clickable headline value. */
  drillLabel?: string;
  /** Affordance, стоящая рядом с числом (ⓘ). Нужна, когда подпись скрыта: иначе иконка остаётся
      одна в пустой строке над числом. Сиблинг кнопки, а не её содержимое — клик по ⓘ не должен
      уводить в разбор. */
  valueAdornment?: ReactNode;
  /**
   * ВТОРАЯ ВЕЛИЧИНА ГЕРОЯ (R8, референс Mercury Insights / Resend Metrics).
   *
   * Герой отвечает «сколько всего», а следующий вопрос читателя — «это много или мало за обычный
   * день». Ответ жил только в тултипе графика, то есть был недоступен без мыши.
   *
   * Место у неё тесное, поэтому она уходит трижды: в S-карточке (`third`) — по выбору владельца,
   * в узком слоте — по замеру самого слота (`tile-narrow:`), ниже `md` — потому что мобильная
   * вёрстка этим ТЗ не трогается. Разметку и причину порядка см. в теле компонента.
   */
  secondary?: { label: string; value: string } | null;
  children: ReactNode;
}

/**
 * Headline, comparison, and chart layout shared by metric cards.
 *
 * Размер крупного числа ОДИН на весь продукт и здесь не выбирается. Раньше его выбирал проп
 * `hero`: с ним 44px, без — 30px. Ставили его не все, и одна и та же метрика жила в двух
 * размерах — «Просмотры» на главной 44px, «Просмотры» на /analytics 30px (замечено владельцем).
 * Проп удалён целиком, а не обесценен: пока он существовал, его можно было забыть.
 */
export function ChartCardBody({
  label,
  value,
  delta,
  deltaBasis,
  range,
  caption,
  onValueClick,
  drillLabel,
  valueAdornment,
  secondary,
  children,
}: ChartCardBodyProps) {
  const expanded = useContext(ChartExpandedContext);
  // Размер карточки, а не ширина экрана: `third` выбрал ВЛАДЕЛЕЦ, и тело подчиняется его выбору
  // (см. lib/widgetSize). Контейнерный запрос `tile-narrow:` ниже — второй, независимый слой: он
  // ловит узкий слот там, где размер формально half (колонка Главной уже колонки Обзора).
  const size = useWidgetSize();
  const showSecondary = secondary != null && size !== 'third';
  /* Подпись НЕ повторяет заголовок карточки. На IG-обзоре карточка называлась «Охват», и над
     числом стояла вторая подпись «Охват» (аудит #554, D8); это вторая серия одного дефекта — до
     неё так же дублировались «Просмотры». Если подпись — заголовок с хвостом окна («Охват · 30
     дн.»), от неё остаётся только хвост: он несёт то, чего в заголовке нет. */
  const cardTitle = useContext(ChartCardTitleContext);
  const headline = (() => {
    if (label == null || cardTitle == null) return label;
    const title = cardTitle.trim();
    const text = String(label).trim();
    if (!title || text.toLowerCase() === title.toLowerCase()) return null;
    const sep = ' · ';
    return text.toLowerCase().startsWith(`${title.toLowerCase()}${sep}`)
      ? text.slice(title.length + sep.length)
      : label;
  })();
  // A metric page already carries the current value and comparison in its inspector rail. Repeating
  // the same KPI inside the report card steals horizontal room from the plot (most visibly on the
  // MoySklad explorers). In an expanded/full-page context the chart is therefore the whole body;
  // the compact story anatomy below remains the canonical card face everywhere else.
  if (expanded) {
    return (
      <div className="h-full min-h-0 w-full" data-chart-card-body data-chart-card-plot>
        {children}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 items-end gap-4" data-chart-card-body>
      <div className="flex shrink-0 flex-col items-start gap-1.5 pb-0.5" data-chart-card-headline>
        {headline != null && <div className="text-xs tracking-wide text-muted-foreground">{headline}</div>}
        {/* KpiNumber: цифры морфятся при смене периода (канон 2026-08-18, паритет с морфом
            графиков); нечисловые строки остаются на снапе ValueSwap внутри него. */}
        <div className="flex items-center gap-1.5">
          <KpiValue
            text={value}
            size="hero"
            onDrill={onValueClick}
            drillLabel={drillLabel}
          />
          {valueAdornment}
        </div>
        <DeltaPill delta={delta} basis={deltaBasis} />
        {showSecondary && (
          // ПОД дельтой, а не в строке с главным числом (расхождение с буквой ТЗ — замер ниже).
          //
          // Референс (Mercury) ставит вторую цифру сбоку от первой, но там график лежит ПОД
          // числами и во всю ширину карточки. У нас анатомия горизонтальная: колонка чисел
          // `shrink-0`, график занимает остаток. Замер на демо, 1440, карточка 543px: строка с
          // добавкой сбоку выросла со 159 до 331px, и полотно упало с 326 до 154px — вдвое, с
          // потерей подписи оси. Отдельной строкой в той же колонке добавка (149px) уже́е строки
          // «Мин · Макс» (159px) и не стоит графику ничего.
          //
          // Порядок «число → дельта → среднее» тоже не косметика: между числом и его дельтой
          // нельзя вставлять второе число — «↑4.5%» прочиталось бы как дельта среднего.
          <div data-chart-card-secondary className="hidden items-baseline gap-1.5 tile-narrow:hidden md:flex">
            {/* morph={false}: барабан цифр (KpiNumber) — канон ГЕРОЙСКОГО числа (владелец
                2026-08-18); два барабана в одной шапке дали бы два движения на один взгляд. */}
            <KpiValue text={secondary.value} size="xs" morph={false} />
            <span className="text-2xs text-muted-foreground">{secondary.label}</span>
          </div>
        )}
        {range != null && (
          <div
            data-chart-card-range
            className="hidden items-baseline gap-1.5 text-2xs tabular-nums tracking-wide text-muted-foreground md:flex"
          >
            <span>Мин</span>
            <span className="font-medium text-foreground">{(range.format ?? fmt.kpi)(range.lo)}</span>
            <span aria-hidden="true">·</span>
            <span>Макс</span>
            <span className="font-medium text-foreground">{(range.format ?? fmt.kpi)(range.hi)}</span>
          </div>
        )}
        {caption != null && <div className="text-2xs text-muted-foreground">{caption}</div>}
      </div>
      <div className="min-h-0 min-w-0 flex-1 self-stretch" data-chart-card-plot>{children}</div>
    </div>
  );
}
