import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useId } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { ChartGapPattern } from '@/components/ChartGapPattern';
import { EmptyState } from '@/components/EmptyState';
import { fmt } from '@/lib/format';
import { observeSize } from '@/lib/observeSize';
import { columnIndex } from '@/lib/chartHover';
import { axisLabelIndexSet } from '@/lib/chartLabels';
import { ChartTooltip, type TooltipRow, type TooltipState } from '@/components/ChartTooltip';
import { axisLabel, niceScale } from '@/components/LineChart';
import { seriesMotionKey } from '@/lib/chartMotion';
import { useMorphValues } from '@/lib/useMorphValues';
import {
  activateChartControl,
  chartControlAriaLabel,
  nextChartControlIndex,
} from '@/lib/chartOverlayControl';
import { ChartExpandedContext, ChartRefLinesContext, ExpandedChartHeightContext, WidgetTargetContext } from '@/components/ExpandableChart';

interface BarChartProps {
  /**
   * `null` = пропуск измерения. Столбец пропуска не рисуется (высота 0) — визуально это то же,
   * что честный ноль, потому что «отсутствующий столбец» в столбчатой диаграмме одну форму и
   * имеет. Различие несёт ПОДПИСЬ: `titles` для пропуска говорит «данных нет» (seriesToChart).
   * Настоящий разрыв показывает {@link LineChart} — там для него есть геометрия.
   */
  values: Array<number | null>;
  labels?: string[];
  /**
   * Подписи ОСИ вместо дат из `labels` (короткое окно ≤ 8 точек: буквы дней недели, канон
   * weekdayAxis). Буквы узкие — подписан КАЖДЫЙ столбец, все по центру колонки. Тултип
   * по-прежнему называет полную дату (titles/labels).
   */
  axisLabels?: string[];
  titles?: string[];
  height?: number;
  /** Comparison series (previous period / baseline). В СТОЛБЦАХ призрак рисуется столбцами же —
      приглушённым `--chart-role-comparison` (см. GHOST_FILL и владельческий комментарий у
      geometry ниже), а не пунктиром: пунктир поверх баров — смешение языков форм. Пунктирный
      канон прошлого периода живёт в {@link LineChart}. Плюс строка легенды. */
  ghost?: Array<number | null>;
  /** Legend/tooltip name for the primary series when ghost is a parallel category, not a period. */
  primaryLabel?: string;
  /** Show a percentage delta between primary and ghost. Disable for parallel categories. */
  comparisonDelta?: boolean;
  /** Metric-aware tooltip formatting; axes remain numeric. */
  formatValue?: (value: number) => string;
  /** Legend name for the ghost series (default «Прошлый период»). */
  ghostLabel?: string;
  /** When set, bars become clickable (a drilldown gesture): a click anywhere on the chart fires
      this with the hovered column index and shows a pointer cursor. Hover behaviour is unchanged. */
  onPointClick?: (index: number) => void;
  /** PINNED column (steep): a persistent highlight + dashed crosshair at this index, set by the
      host page from onPointClick — the anchor for a «этот день» panel. null/undefined = off. */
  pinnedIndex?: number | null;
  /** Whether the comparison legend chip is an interactive show/hide toggle (default). Pass false
      where a page-level compare control already owns the on/off (the metric page). */
  legendToggle?: boolean;
  /** Visual relationship between two series. The default keeps legacy grouped pairs; `stacked`
      is the shadcn-style detail-view treatment with one segmented column per date. */
  comparisonStyle?: 'grouped' | 'stacked';
  /** Compact shadcn-style tooltip and higher-contrast series treatment for the metric explorer. */
  appearance?: 'default' | 'comparison';
}

interface Hover {
  i: number;
}

// Bars never grow wider than this — sparse series (n=2) must not render giant slabs.
const MAX_BAR_W = 48;
// Bar takes 70% of its column; the rest is gap.
const BAR_RATIO = 0.7;
// Approximate glyph width of the 11px tabular numerals used for tick/value labels.
const CHAR_W = 6.6;
// Горизонтальное поле пилюли текущей метки оси X (px с каждой стороны текста).
const AXIS_PILL_PAD = 6;
// ОДНА альфа призрачных столбцов на все подачи: grouped-пара, stacked-сегмент, hover-хайлайт,
// свотчи легенды и точка в тултипе. Раньше grouped жил на /0.35, а stacked и хайлайт — в полную
// непрозрачность, из-за чего «прошлый период» звучал то тише, то громче текущего.
// ЗНАЧЕНИЕ 0.8 НЕ ПРОИЗВОЛЬНОЕ — это та же альфа, на которой уже нарисован пунктирный призрак
// линейного хоста (LineChart/MorphingSeries strokeOpacity 0.8), и единственный диапазон, проходящий
// non-text 3.0 на БЕЛОЙ карточке светлой темы: chart-2 @0.8 = 3.52, @0.5 = 2.07, @0.35 = 1.63
// (тёмная тема мягче и прошла бы и на 0.5). Тише текущего периода призрак делает ЧУЖОЙ ТОН (амбра
// против ириса), а не растворение в фоне. Менять только вместе со строкой «comparison ghost @0.8»
// в scripts/contrast-tokens.mjs — гейт парсит эту константу отсюда и падает при рассинхроне.
const GHOST_ALPHA = 0.8;
const GHOST_FILL = `hsl(var(--chart-role-comparison) / ${GHOST_ALPHA})`;

interface BarBox { x: number; y: number; w: number; h: number }

// Радиус внешних углов столбца (владелец, 2026-08-14: «острые углы → закруглённое всё»). Одна
// константа на одиночные бары, grouped-пары, stacked-сегменты и hover/pinned-подсветку — иначе
// подсветка перерисовывала бы столбец с другой формой углов. Узкий/низкий столбец клампится
// половиной своей стороны, так что плотные серии не превращаются в капсулы.
const BAR_CORNER_R = 6;

/** A stack segment with independently rounded outer corners, avoiding seams at the join.
    Экспорт: DivergingBars скругляет той же формой внешний угол плюс/минус-баров. */
export function stackSegmentPath(box: BarBox, roundTop: boolean, roundBottom: boolean): string {
  if (box.h <= 0 || box.w <= 0) return '';
  const top = roundTop ? Math.min(BAR_CORNER_R, box.w / 2, box.h / 2) : 0;
  const bottom = roundBottom ? Math.min(BAR_CORNER_R, box.w / 2, box.h / 2) : 0;
  const right = box.x + box.w;
  const base = box.y + box.h;
  return [
    `M ${box.x + top} ${box.y}`,
    `H ${right - top}`,
    top ? `Q ${right} ${box.y} ${right} ${box.y + top}` : `L ${right} ${box.y}`,
    `V ${base - bottom}`,
    bottom ? `Q ${right} ${base} ${right - bottom} ${base}` : `L ${right} ${base}`,
    `H ${box.x + bottom}`,
    bottom ? `Q ${box.x} ${base} ${box.x} ${base - bottom}` : `L ${box.x} ${base}`,
    `V ${box.y + top}`,
    top ? `Q ${box.x} ${box.y} ${box.x + top} ${box.y}` : `L ${box.x} ${box.y}`,
    'Z',
  ].join(' ');
}

export function BarChart({
  values: rawValues,
  labels,
  axisLabels,
  titles,
  height = 200,
  ghost: rawGhost,
  primaryLabel = 'Текущий',
  ghostLabel = 'Прошлый период',
  comparisonDelta = true,
  formatValue = fmt.num,
  onPointClick,
  legendToggle = true,
  pinnedIndex = null,
  comparisonStyle = 'grouped',
  appearance = 'default',
}: BarChartProps) {
  // Геометрия столбцов числовая, а пропуск в ней невыразим — сводим его к нулевой высоте ОДИН
  // раз, на входе. Честность при этом не теряется: `titles` уже несёт «данных нет» для пропуска,
  // а «Макс/Среднее» считаются выше по потоку, до этого приведения, и пропуск в них не попадает.
  const values = useMemo(() => (rawValues ?? []).map((value) => value ?? 0), [rawValues]);
  // «0 ≠ n/a»: честный ноль и пропуск измерения дают одинаково невидимый столбец, поэтому
  // различие обязана нести колонка-подложка. Пропуск получает штриховку на всю высоту плота —
  // видно, что день БЫЛ, но не измерен; ноль остаётся пустым местом, потому что он измерен.
  const gapIdx = useMemo(
    () => new Set((rawValues ?? []).flatMap((value, i) => (value == null ? [i] : []))),
    [rawValues],
  );
  const ghost = useMemo(
    () => (rawGhost == null ? undefined : rawGhost.map((value) => value ?? 0)),
    [rawGhost],
  );
  const gapPatternId = `bcgap${useId().replace(/:/g, '')}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // Press position (client px) for the drag guard: the svg-level onClick would otherwise drill on
  // a press-drag-release scrub (the browser retargets a cross-child click to the svg). null = no
  // press recorded, so a keyboard/AT-synthesized click still passes through.
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  // Focus follows pointerdown on a native button. Keep that focus event from erasing the fresh
  // press coordinates, while still letting a later keyboard focus discard interrupted stale data.
  const pointerDownRef = useRef(false);
  const [hover, setHover] = useState<Hover | null>(null);
  // The comparison overlay can be toggled off via its legend chip (steep #9) — hidden, it also
  // drops out of the bar y-domain so the bars rescale to the current series.
  const [ghostHidden, setGhostHidden] = useState(false);
  // A freshly-enabled or changed comparison always starts SHOWN: reset the manual hide when the
  // ghost's content changes, keyed on a content signature (not identity) so a referentially-
  // unstable-but-equal re-render never resets it (which would make the chip un-clickable).
  const ghostKey = ghost && ghost.length >= 2 ? ghost.join(',') : '';
  const prevGhostKey = useRef(ghostKey);
  useEffect(() => {
    if (ghostKey === prevGhostKey.current) return;
    prevGhostKey.current = ghostKey;
    if (ghostKey) setGhostHidden(false);
  }, [ghostKey]);
  // Measure render width so the viewBox is 1:1 with CSS pixels — a fixed 600-wide viewBox
  // scaled to fit would render labels/bars at inconsistent, fuzzy sizes.
  const [width, setWidth] = useState(600);
  const [hostHeight, setHostHeight] = useState(0);
  // Expanded (modal) rendering opts into value labels + y ticks.
  const expanded = useContext(ChartExpandedContext);
  const refLines = useContext(ChartRefLinesContext);
  // The overlay dictates its explorer height; inline renders keep the caller's `height`.
  const ctxHeight = useContext(ExpandedChartHeightContext);
  // Per-widget goal line — same source LineChart reads, so the target survives the
  // line↔bar variant switch. null everywhere outside a widget with a set target.
  const targetCtx = useContext(WidgetTargetContext);
  const target = targetCtx != null && Number.isFinite(targetCtx) ? targetCtx : null;

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.clientWidth || 600);
      // Высоту тоже берём у контейнера, когда он её ДИКТУЕТ (flex-полоса компактной карточки,
      // `h-full` внутри плитки). Без этого столбцы рисовались на дефолтные 200px в полосе ~100px,
      // тайл переполнялся и получал внутренний скроллбар — канон плотности запрещает
      // (e2e «no inner scrollbars»; вскрылось, когда столбцы стали дефолтом дискретных метрик).
      // Контейнер с auto-высотой отдаёт высоту собственного контента — тогда значение совпадает
      // с текущим `height` и поведение прежнее, без цикла измерений.
      setHostHeight(el.clientHeight || 0);
    };
    measure();
    return observeSize(el, measure);
  }, []);

  // The readout must not linger once the chart scrolls under the sticky header or the
  // window loses focus — mouseleave alone does not fire during wheel scrolling.
  const hasHover = hover !== null;
  useEffect(() => {
    if (!hasHover) return;
    const clear = () => {
      pointerDownRef.current = false;
      pressRef.current = null;
      setHover(null);
    };
    window.addEventListener('scroll', clear, true);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('scroll', clear, true);
      window.removeEventListener('blur', clear);
    };
  }, [hasHover]);

  const hasGhost = !!ghost && ghost.length === values.length && ghost.length >= 2;
  // Toggled off, the comparison drops out of every draw/measure below; the legend chip stays
  // visible so it can be toggled back on. Derived before the plot memo (its inputs).
  const showGhost = hasGhost && !ghostHidden;
  const activeGhost = showGhost ? ghost : undefined;

  // Stable data signature for the UPDATE morph (see index.css «Chart motion»). Keyed on the SERIES
  // content — primary values + the shown comparison — so the bar silhouette FLOWS into the new shape
  // on a period / filter / compare change (useMorphValues below), but NOT on hover (separate state),
  // tooltip movement or a ResizeObserver width change (width is absent). The baseline grow is
  // mount-only: the [data-chart-motion="grow"] group is no longer remounted per data change.
  const motionKey = seriesMotionKey(values, activeGhost);

  // ── Geometry + the static plot, memoized APART from hover ────────────────────────────────
  // Hover used to swap every bar's opacity and re-create the whole element tree per mousemove
  // (plus a transparent hit-rect per column). Now the bars render ONCE into a cached layer; the
  // hover dim is a single group-opacity attribute, the hovered bar is re-drawn at full opacity
  // in the overlay below, and the svg carries ONE mouse handler with O(1) column math.
  const plot = useMemo(() => {
    if (!values || values.length === 0) return null;

    const stacked = comparisonStyle === 'stacked' && !!activeGhost;

    // Expanded view: bars scale against a NICE domain top (1/2/5×10ⁿ) so the y ticks land on
    // round values, like LineChart — the old max/mid pair printed «262» next to «2.5k».
    // A stacked comparison owns the sum-domain; grouped pairs keep the larger individual value.
    const stackedTotals = stacked ? values.map((value, i) => value + (activeGhost?.[i] ?? 0)) : [];
    const rawMax = Math.max(...values, 1, target ?? 0, ...(activeGhost ?? []), ...stackedTotals);
    const scale = expanded ? niceScale(0, rawMax) : null;
    const max = scale ? scale.hi : rawMax;
    const n = values.length;
    const chartWidth = Math.max(width, 1);
    // In a fixed-height card tile (ctxHeight set, not the expanded overlay), the comparison legend
    // is an HTML row BELOW the svg — reserve its height so svg + legend fit the tile with no inner
    // scrollbar. (X-labels are drawn INSIDE the svg via paddingBottom, so they need no reservation.)
    const legendRow = ctxHeight != null && !expanded && hasGhost ? 22 : 0;
    // Приоритет высоты: контекст развёртки → измеренная полоса хоста → проп. Легенда сравнения
    // резервируется и в измеренном хосте — иначе она вылезает за плитку тем же способом.
    const hostBand = !expanded && hostHeight > 0 ? hostHeight : null;
    const legendReserve = hostBand != null && !expanded && hasGhost ? 22 : legendRow;
    const chartHeight = Math.max((ctxHeight ?? hostBand ?? height) - legendReserve, 60);
    const paddingBottom = labels && labels.length > 0 ? 24 : 0;
    const graphHeight = chartHeight - paddingBottom;
    // Expanded view: headroom for the value labels above full-height bars.
    const padTop = expanded ? 18 : 0;
    const usable = Math.max(graphHeight - padTop, 1);

    // Expanded view: nice-tick labels right-aligned in a reserved left gutter (0 = baseline).
    // Дедуп подписей — как в LineChart: на крошечном домене (все значения 0 → hi=1) шкала даёт
    // тики 1 / 0.5, а axisLabel округляет оба в «1», и ось печатала «1 1 0».
    const scaledTicks = scale
      ? scale.ticks
          .filter((t) => t > 0)
          .map((v) => ({ v, label: axisLabel(v, scale.step) }))
          .filter((tick, i, arr) => i === 0 || tick.label !== arr[i - 1].label)
      : [];
    const yTicks = scaledTicks.map((t) => t.v);
    const tickLabels = scaledTicks.map((t) => t.label);
    const gutterW = expanded
      ? Math.max(28, Math.round(Math.max(...tickLabels.map((l) => l.length)) * CHAR_W) + 14)
      : 0;

    // Cap the column width and center the group when there are few bars.
    const plotW = Math.max(chartWidth - gutterW, 10);
    const itemWidth = Math.min(plotW / n, MAX_BAR_W / BAR_RATIO);
    const barWidth = itemWidth * BAR_RATIO;
    const offsetX = gutterW + (plotW - itemWidth * n) / 2;
    // Буквенная ось короткого окна (axisLabels): буквы узкие, подписан КАЖДЫЙ столбец — без
    // прореживания «M _ W _ F» ряд терял бы ритм недели. Даты прореживаются по ширине, как раньше.
    const letterAxis = axisLabels && axisLabels.length === n ? axisLabels : null;
    // Thin x-labels by measured width; labels are hidden rather than rotated in tight cards.
    const labelIndexes = letterAxis
      ? new Set(values.map((_, i) => i))
      : axisLabelIndexSet(n, plotW, { minLabelPx: expanded ? 68 : 78, maxLabels: expanded ? 12 : 7 });

    const barTop = (val: number) => graphHeight - (val / max) * usable;
    const barCenterX = (i: number) => offsetX + i * itemWidth + itemWidth / 2;

    // Сравнение в СТОЛБЦАХ рисуется столбцами же (владелец: пунктирная линия поверх баров
    // «странно смотрится» — смешение языков форм). Это ОСОЗНАННОЕ исключение из канона
    // «previous-period stays dashed/no-fill»: канон про пунктир держит линейный хост (LineChart),
    // а здесь тише звучит альфа (GHOST_FILL), а не форма. Форму не менять.
    // Группированные пары: прошлое слева (приглушённый comparison-тон), текущее справа;
    // 2px-зазор внутри пары (dataviz-канон).
    const GROUP_GAP = 2;
    const subW = activeGhost && !stacked ? Math.max((barWidth - GROUP_GAP) / 2, 1) : barWidth;
    const bandX = (i: number) => offsetX + i * itemWidth + (itemWidth - barWidth) / 2;

    // Per-bar boxes — the cached rect layer below and the hover highlight both draw from these.
    // With a comparison, the CURRENT bar takes the right half of the band.
    const bars = values.map((val, i) => {
      const barHeight = (val / max) * usable;
      return {
        x: bandX(i) + (activeGhost && !stacked ? subW + GROUP_GAP : 0),
        y: graphHeight - barHeight,
        w: subW,
        // Zero is a real absence, not a tiny bar. Keeping the old 2px minimum for positive values
        // preserves visibility of small counts without drawing a false dotted baseline on sparse
        // daily series such as mentions.
        h: val === 0 ? 0 : stacked ? barHeight : Math.max(barHeight, 2),
      };
    });
    // Колонки-подложки для пропусков (см. gapIdx): та же геометрия бэнда, полная высота плота.
    const gapCols = [...gapIdx].map((i) => ({ i, x: bandX(i), w: Math.max(barWidth, 1) }));

    const ghostBars = activeGhost
      ? activeGhost.map((v, i) => {
          const h = (v / max) * usable;
          return {
            x: bandX(i),
            y: stacked ? bars[i].y - h : graphHeight - h,
            w: subW,
            h: v === 0 ? 0 : stacked ? h : Math.max(h, 2),
          };
        })
      : [];
    // Under the bars: the zero baseline, then gridlines + tick labels (expanded only).
    // Базовая линия рисуется ВСЕГДА: нулевой столбец честно имеет высоту 0, и без неё окно, где
    // все значения нулевые (пустой фильтр, канал чужой сети), выглядело как «график не отрисовался»
    // — пустое место вместо ряда на нуле. Столбчатой диаграмме нулевая база нужна и по канону.
    const underLayer = (
      <>
        {/* «0 ≠ n/a» (канон Semrush Intergalactic: «Zero counts as data»). Нулевой и отсутствующий
            столбец геометрически неразличимы — оба невидимы. Пропуск получает штрихованную
            подложку на всю высоту плота: день был, но не измерен. Честный ноль подложки не
            получает — он измерен. Декоративно для AT: смысл несёт подпись тултипа. */}
        {gapCols.length > 0 && (
          <>
            <defs>
              <ChartGapPattern id={gapPatternId} />
            </defs>
            {gapCols.map((col) => (
              <rect
                key={`gapcol${col.i}`}
                x={col.x}
                y={0}
                width={col.w}
                height={graphHeight}
                fill={`url(#${gapPatternId})`}
                className="pointer-events-none"
              />
            ))}
          </>
        )}
        <line
          x1={gutterW}
          y1={graphHeight}
          x2={chartWidth}
          y2={graphHeight}
          stroke="hsl(var(--border))"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        {yTicks.map((v, idx) => {
          const y = barTop(v);
          return (
            <g key={`t${idx}`}>
              <line x1={gutterW} y1={y} x2={chartWidth} y2={y} stroke="hsl(var(--border))" strokeDasharray="4 6" strokeWidth="1" opacity="0.6" vectorEffect="non-scaling-stroke" />
              <text x={gutterW - 8} y={y + 3.5} textAnchor="end" className="pointer-events-none select-none fill-muted-foreground text-2xs font-medium tabular-nums">
                {tickLabels[idx]}
              </text>
            </g>
          );
        })}
      </>
    );

    // Above the bars: value/x labels (never dimmed — parity with the old per-rect opacity),
    // then the comparison overlay and the target line.
    const overLayer = (
      <>
        {values.map((val, i) => {
          const strideHit = labelIndexes.has(i);
          const axisText = letterAxis ? letterAxis[i] : labels?.[i];
          const showLabel = axisText && strideHit;
          const showValue = expanded && strideHit && !stacked;
          if (!showLabel && !showValue) return null;
          const isLast = i === values.length - 1;
          // Крайние ДАТЫ прижимаются к краям плота (start/end), а не центрируются под столбцом —
          // центрированная последняя дата наполовину вылетала за svg и клипалась («9 ин» вместо
          // «9 июл.», дизайн-проход №3). Зеркало поведения LineChart. Буквы дней недели узкие и
          // центрируются под КАЖДЫМ столбцом (референс владельца). Последняя метка при этом
          // отступает от края на поле своей пилюли, чтобы пилюля не клипалась рамкой svg.
          const labelX = letterAxis
            ? barCenterX(i)
            : isLast
              ? Math.min(bars[i].x + bars[i].w, width - 1) - (labels?.[i] ? AXIS_PILL_PAD : 0)
              : i === 0
                ? Math.max(bandX(i), 1)
                : barCenterX(i);
          const anchor = letterAxis ? 'middle' : isLast ? 'end' : i === 0 ? 'start' : 'middle';
          // ПИЛЮЛЯ текущей (последней) метки — «где сейчас» на оси (референс владельца:
          // «Aug» / обведённая «T»). viewBox здесь 1:1 с CSS-px, поэтому скруглённый rect не
          // искажается. Ширина текста оценивается CHAR_W — тем же приёмом, что y-gutter.
          const pill = showLabel && isLast
            ? (() => {
                const textW = String(axisText).length * CHAR_W;
                const pillH = 15;
                const pillW = Math.max(textW + AXIS_PILL_PAD * 2, pillH);
                const x = anchor === 'end' ? labelX - textW - AXIS_PILL_PAD : labelX - pillW / 2;
                return { x: Math.max(1, x), w: pillW, h: pillH };
              })()
            : null;
          return (
            <g key={`l${i}`}>
              {showValue && (
                <text
                  x={bars[i].x + bars[i].w / 2}
                  y={bars[i].y - 4}
                  textAnchor="middle"
                  className="pointer-events-none select-none fill-ink2 text-2xs font-medium tabular-nums"
                >
                  {fmt.short(val)}
                </text>
              )}
              {showLabel && (
                <g data-axis-current={isLast ? '' : undefined}>
                  {pill && (
                    // Цвет пилюли = цвет серии (владелец, референс steep): солидный
                    // chart-role-primary, чернила — фон; тонированные карточки переопределяют
                    // токен в своём скоупе, и пилюля перекрашивается вместе со столбцами.
                    <rect
                      x={pill.x}
                      y={chartHeight - 17.5}
                      width={pill.w}
                      height={pill.h}
                      rx={pill.h / 2}
                      fill="hsl(var(--chart-role-primary))"
                      className="pointer-events-none"
                    />
                  )}
                  <text
                    x={labelX}
                    y={chartHeight - 6}
                    textAnchor={anchor}
                    data-chart-axis-label="x"
                    fill={isLast ? 'hsl(var(--background))' : undefined}
                    className={`pointer-events-none select-none text-2xs font-medium tabular-nums ${isLast ? '' : 'fill-muted-foreground'}`}
                  >
                    {axisText}
                  </text>
                </g>
              )}
            </g>
          );
        })}

        {/* Target level (widget pref) — dashed goal line + right-aligned label, above the bars */}
        {target != null && (
          <>
            <line x1={gutterW} y1={barTop(target)} x2={chartWidth} y2={barTop(target)} stroke="hsl(var(--chart-role-neutral))" strokeDasharray="6 4" strokeWidth="1.2" opacity="0.8" vectorEffect="non-scaling-stroke" className="pointer-events-none" />
            <text
              x={chartWidth - 4}
              y={barTop(target) - 4 < 10 ? barTop(target) + 12 : barTop(target) - 4}
              textAnchor="end"
              className="pointer-events-none select-none fill-muted-foreground text-2xs font-medium tabular-nums"
            >
              цель {fmt.short(target)}
            </text>
          </>
        )}

        {/* Min/Max/Average reference lines (overlay «Линии» toggle) — dashed hairlines at the visible
            extremes + mean, above the bars. */}
        {refLines && (
          <>
            {([['макс', refLines.max], ['сред.', refLines.avg], ['мин', refLines.min]] as const).map(([lbl, v]) => (
              <g key={lbl} className="pointer-events-none">
                <line x1={gutterW} y1={barTop(v)} x2={chartWidth} y2={barTop(v)} stroke="hsl(var(--chart-role-neutral))" strokeDasharray="6 4" strokeWidth="1.2" opacity="0.7" vectorEffect="non-scaling-stroke" />
                <text
                  x={chartWidth - 4}
                  y={barTop(v) - 4 < 10 ? barTop(v) + 12 : barTop(v) - 4}
                  textAnchor="end"
                  className="pointer-events-none select-none fill-muted-foreground text-2xs font-medium tabular-nums"
                >
                  {lbl} {fmt.short(v)}
                </text>
              </g>
            ))}
          </>
        )}
      </>
    );

    return { chartWidth, chartHeight, graphHeight, offsetX, itemWidth, bars, ghostBars, stacked, barTop, barCenterX, underLayer, overLayer };
  }, [values, labels, axisLabels, activeGhost, hasGhost, target, refLines, width, ctxHeight, hostHeight, height, expanded, comparisonStyle, gapIdx, gapPatternId]);

  // ── UPDATE morph: the silhouette flows into the new shape on a data change ────────────────
  // Heights (the ONE dimension the data owns — x/width are layout) tween from the previously
  // rendered silhouette to the target via useMorphValues('silhouette'): a 30→7 period swap
  // proportionally maps every new column onto the old shape, so bars flow instead of replaying the
  // baseline grow. All boxes below (bars layer, hover/pinned highlight, tooltip anchors) derive from
  // the MORPHED heights, so nothing floats off a moving bar mid-flight.
  const targetBarHeights = useMemo(() => (plot ? plot.bars.map((b) => b.h) : []), [plot]);
  const targetGhostHeights = useMemo(() => (plot ? plot.ghostBars.map((b) => b.h) : []), [plot]);
  const barHeights = useMorphValues(targetBarHeights, motionKey, 'silhouette');
  const ghostHeights = useMorphValues(targetGhostHeights, motionKey, 'silhouette');
  const morphed = useMemo(() => {
    if (!plot) return null;
    const bars = plot.bars.map((b, i) => {
      const h = barHeights[i] ?? b.h;
      return { ...b, h, y: plot.graphHeight - h };
    });
    const ghostBars = plot.ghostBars.map((b, i) => {
      const h = ghostHeights[i] ?? b.h;
      return { ...b, h, y: plot.stacked ? (bars[i]?.y ?? plot.graphHeight) - h : plot.graphHeight - h };
    });
    const columnTops = bars.map((b, i) => (plot.stacked && (ghostBars[i]?.h ?? 0) > 0 ? ghostBars[i].y : b.y));
    return { bars, ghostBars, columnTops };
  }, [plot, barHeights, ghostHeights]);

  // The bars themselves — flat single-token fill; the render site wraps this layer in a group whose
  // opacity carries the hover dim. Rebuilt per morph frame from the morphed boxes (≤ CHART_MAX_POINTS
  // columns — cheap); hover still never rebuilds it (hover state is not an input here).
  const barsLayer = useMemo(() => {
    if (!plot || !morphed) return null;
    const { bars, ghostBars } = morphed;
    return (
      <>
        {bars.map((b, i) => plot.stacked ? (
          <path
            key={`b${i}`}
            data-chart-series="current"
            d={stackSegmentPath(b, (ghostBars[i]?.h ?? 0) <= 0, true)}
            fill="hsl(var(--chart-role-primary))"
          />
        ) : (
          // Одиночный столбец: скруглённый ВЕРХ, прямое основание на базовой линии — капсула,
          // оторванная от оси, читалась бы как «плавающий» бар (stackSegmentPath клампит радиус).
          <path key={`b${i}`} data-chart-series="current" d={stackSegmentPath(b, true, false)} fill="hsl(var(--chart-role-primary))" />
        ))}
        {ghostBars.map((b, i) => plot.stacked ? (
          <path
            key={`gb${i}`}
            data-chart-series="comparison"
            d={stackSegmentPath(b, true, (bars[i]?.h ?? 0) <= 0)}
            fill={GHOST_FILL}
          />
        ) : (
          <path key={`gb${i}`} data-chart-series="comparison" d={stackSegmentPath(b, true, false)} fill={GHOST_FILL} />
        ))}
      </>
    );
  }, [plot, morphed]);

  // Hover-only charts have no activation semantics: the SVG stays one passive named graphic and
  // pointer scrubbing is registered on its DOM node. Drillable charts use the real overlay button
  // rendered below, so that same gesture also has a keyboard/focus equivalent.
  useEffect(() => {
    const container = containerRef.current;
    const svg = svgRef.current;
    if (!container || !svg || !plot || values.length === 0) return;
    const clear = () => {
      pointerDownRef.current = false;
      pressRef.current = null;
      setHover(null);
    };
    const handleMove = (event: globalThis.MouseEvent) => {
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0) return;
      const xView = ((event.clientX - rect.left) / rect.width) * plot.chartWidth;
      const i = columnIndex(xView, values.length, plot.offsetX, plot.itemWidth);
      if (i == null) return;
      setHover((prev) => (prev && prev.i === i ? prev : { i }));
    };
    if (!onPointClick) svg.addEventListener('mousemove', handleMove);
    container.addEventListener('mouseleave', clear);
    container.addEventListener('pointerleave', clear);
    return () => {
      if (!onPointClick) svg.removeEventListener('mousemove', handleMove);
      container.removeEventListener('mouseleave', clear);
      container.removeEventListener('pointerleave', clear);
    };
  }, [onPointClick, plot, values.length]);

  if (!values || values.length === 0 || !plot || !morphed) {
    return <EmptyState compact size="chart" title="Нет данных за период" />;
  }

  const { chartWidth, chartHeight, graphHeight, offsetX, itemWidth, stacked, barTop, barCenterX } = plot;
  // Hover/pinned highlight + tooltip anchors read the MORPHED boxes so they track a mid-flight bar.
  const { bars, ghostBars, columnTops } = morphed;
  const n = values.length;
  const ariaMax = stacked && activeGhost
    ? Math.max(...values.map((value, i) => value + (activeGhost[i] ?? 0)))
    : Math.max(...values);

  const tipText = (i: number) => {
    // Пропуск обязан называться словами: подпись — единственное, чем «нет данных» отличается от
    // измеренного нуля, когда столбца не видно в обоих случаях. `titles` от seriesToChart уже
    // несут «данных нет»; фолбэк — для прямых вызовов BarChart без titles.
    const base = titles?.[i] ?? `${labels?.[i] ?? ''}: ${gapIdx.has(i) ? 'данных нет' : values[i]}`;
    return activeGhost && activeGhost[i] != null ? `${base} · пред. ${fmt.num(activeGhost[i])}` : base;
  };
  // Structured readout (label · Текущий · comparison · Δ) when a ghost series is present; else the
  // metric's own title text. Anchored to the hovered bar's top-centre.
  const buildTip = (i: number): TooltipState => {
    const x = barCenterX(i);
    const y = columnTops[i] ?? barTop(values[i]);
    if (activeGhost && activeGhost[i] != null) {
      const cur = values[i];
      const prev = activeGhost[i];
      const rows: TooltipRow[] = [
        { label: primaryLabel, value: formatValue(cur), color: 'hsl(var(--chart-role-primary))' },
        // Свотч сравнения повторяет ровно ту же альфу, что столбцы и чипы легенды (GHOST_FILL):
        // один ряд не может звучать в трёх насыщенностях одновременно.
        { label: ghostLabel, value: formatValue(prev), color: GHOST_FILL },
      ];
      const d = prev !== 0 ? ((cur - prev) / Math.abs(prev)) * 100 : null;
      if (comparisonDelta && d != null && Number.isFinite(d)) rows.push({ label: 'Δ', value: `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}%` });
      return { x, y, title: labels?.[i], rows };
    }
    if (expanded) {
      return {
        x,
        y,
        title: labels?.[i],
        rows: [
          {
            label: 'Текущий период',
            value: formatValue(values[i]),
            color: 'hsl(var(--chart-role-primary))',
          },
        ],
      };
    }
    return { x, y, text: tipText(i) };
  };

  // One surface maps pointer x to a column in O(1); moving inside the same column keeps the state
  // object stable. For a drillable chart that surface is the semantic overlay button.
  const indexFromClientX = (clientX: number, surface: Element): number | null => {
    const rect = surface.getBoundingClientRect();
    if (rect.width === 0) return null;
    const xView = ((clientX - rect.left) / rect.width) * chartWidth;
    return columnIndex(xView, n, offsetX, itemWidth);
  };
  const onSurfaceMove = (e: ReactMouseEvent<HTMLButtonElement>) => {
    const i = indexFromClientX(e.clientX, e.currentTarget);
    if (i == null) return;
    setHover((prev) => (prev && prev.i === i ? prev : { i }));
  };
  // Drill only on a genuine click, not a scrub: a press that travelled >5px before release is a
  // drag-to-read gesture, not a tap. A click with no recorded press (keyboard / AT) passes through.
  const fallbackControlIndex =
    pinnedIndex != null && pinnedIndex >= 0 && pinnedIndex < n ? pinnedIndex : n - 1;
  const controlIndex = hover?.i ?? fallbackControlIndex;
  const onSurfaceClick = onPointClick
    ? (e: ReactMouseEvent<HTMLButtonElement>) => {
        const press = pressRef.current;
        pressRef.current = null;
        pointerDownRef.current = false;
        // Resolve keyboard/AT FIRST: a cancelled old pointer gesture must never suppress a
        // detail=0 click produced by Enter, Space or assistive technology.
        activateChartControl(
          {
            detail: e.detail,
            controlIndex,
            pointerIndex: e.detail === 0 ? null : indexFromClientX(e.clientX, e.currentTarget),
            press,
            clientX: e.clientX,
            clientY: e.clientY,
          },
          (i) => {
            // The chart OWNS this click (point drill / pin) — keep it out of the host card's
            // whole-card expand.
            e.stopPropagation();
            onPointClick(i);
          },
        );
      }
    : undefined;
  const clearHover = () => {
    pointerDownRef.current = false;
    pressRef.current = null;
    setHover(null);
  };

  return (
    <div ref={containerRef} className="relative w-full">
      <svg
        ref={svgRef}
        data-chart-kind="bar"
        data-chart-expanded={expanded ? '' : undefined}
        data-chart-appearance={appearance}
        data-chart-comparison={stacked ? 'stacked' : activeGhost ? 'grouped' : undefined}
        className={`block w-full ${onPointClick ? 'cursor-pointer' : 'cursor-crosshair'}`}
        height={chartHeight}
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        preserveAspectRatio="none"
        // Named graphic for AT (PieChart idiom) — see LineChart.tsx: series max, not the scale top.
        role="img"
        aria-label={`Столбчатая диаграмма: ${values.length} столбцов, макс ${fmt.short(ariaMax)}`}
      >
        {/* БЕЗ svg <title> — см. LineChart: aria-label уже именует график, а <title> дублировал
            его нестилизуемым нативным тултипом с острыми углами поверх ChartTooltip. */}
        {plot.underLayer}

        {/* Bar rects; hovering dims the whole group and the highlight below re-draws the
            hovered bar at full opacity — same reading as the old per-bar opacity swap, without
            re-rendering a rect per column per mousemove. transition-opacity only WHILE hovered so
            the un-dim on leave snaps (the full-opacity highlight unmounts in the same commit) — no
            below-idle dip on the just-hovered bar. */}
        <g className={hover ? 'transition-opacity' : undefined} opacity={hover ? 0.5 : appearance === 'comparison' ? 1 : 0.85}>
          {/* Inner group grows the bars from the baseline ONCE on mount (fill-box scaleY). Data
              changes no longer remount it — the silhouette MORPHS via useMorphValues above, mirroring
              the line charts' mount-reveal + update-morph split. */}
          <g data-chart-motion="grow">
            {barsLayer}
          </g>
        </g>

        {/* Full-opacity highlight of the hovered bar — BETWEEN the dimmed bars and the ghost/target
            overlay, so the comparison + goal lines still paint OVER it (HEAD paint order). */}
        {hover && hover.i < n && stacked ? (
          <g className="pointer-events-none">
            <path
              d={stackSegmentPath(bars[hover.i], ghostBars[hover.i]?.h <= 0, true)}
              fill="hsl(var(--chart-role-primary))"
            />
            {ghostBars[hover.i] && (
              <path
                d={stackSegmentPath(ghostBars[hover.i], true, bars[hover.i]?.h <= 0)}
                fill={GHOST_FILL}
              />
            )}
          </g>
        ) : hover && hover.i < n ? (
          // Та же скруглённая форма, что у самого столбца, — иначе подсветка перерисовывала бы
          // бар с другими углами.
          <path d={stackSegmentPath(bars[hover.i], true, false)} fill="hsl(var(--chart-role-selection))" className="pointer-events-none" />
        ) : null}

        {plot.overLayer}

        {/* PINNED column — persistent highlight + dashed crosshair (under the live hover). */}
        {pinnedIndex != null && pinnedIndex < n && bars[pinnedIndex] && (
          <g className="pointer-events-none">
            {stacked ? (
              <rect
                x={bars[pinnedIndex].x}
                y={columnTops[pinnedIndex]}
                width={bars[pinnedIndex].w}
                height={graphHeight - columnTops[pinnedIndex]}
                fill="none"
                stroke="hsl(var(--chart-role-selection))"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
                rx={BAR_CORNER_R}
              />
            ) : (
              <path d={stackSegmentPath(bars[pinnedIndex], true, false)} fill="hsl(var(--chart-role-selection))" />
            )}
            <line
              x1={barCenterX(pinnedIndex)}
              y1={0}
              x2={barCenterX(pinnedIndex)}
              y2={graphHeight}
              stroke="hsl(var(--chart-role-selection))"
              strokeWidth="1.5"
              strokeDasharray="2 3"
              opacity="0.6"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        )}

        {/* Hovered-column crosshair + the comparison point on it, painted over everything (parity
            with LineChart / HEAD). */}
        {hover && hover.i < n && (
          <g className="pointer-events-none">
            <line
              data-chart-crosshair
              x1={barCenterX(hover.i)}
              y1={0}
              x2={barCenterX(hover.i)}
              y2={graphHeight}
              stroke="hsl(var(--chart-role-selection))"
              strokeWidth="1.25"
              strokeDasharray="3 4"
              opacity="0.72"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        )}
      </svg>
      {onPointClick && (
        <button
          type="button"
          aria-label={chartControlAriaLabel({
            index: controlIndex,
            label: labels?.[controlIndex],
            fallbackNoun: 'столбец',
            value: formatValue(values[controlIndex]),
          })}
          aria-keyshortcuts="ArrowLeft ArrowRight Home End"
          className="absolute inset-x-0 top-0 z-10 block w-full cursor-pointer rounded bg-transparent p-0 text-left hover:bg-transparent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50"
          style={{ height: chartHeight }}
          onMouseMove={onSurfaceMove}
          onPointerDown={(event) => {
            pointerDownRef.current = true;
            pressRef.current = { x: event.clientX, y: event.clientY };
          }}
          onPointerUp={() => {
            // Keep coordinates through the following click; only the active-pointer flag ends here.
            pointerDownRef.current = false;
          }}
          onPointerCancel={() => {
            pointerDownRef.current = false;
            pressRef.current = null;
          }}
          onClick={onSurfaceClick}
          onFocus={() => {
            if (!pointerDownRef.current) pressRef.current = null;
            setHover((current) => current ?? { i: fallbackControlIndex });
          }}
          onBlur={clearHover}
          onKeyDown={(event) => {
            const next = nextChartControlIndex(event.key, controlIndex, n);
            if (next == null) return;
            event.preventDefault();
            setHover({ i: next });
          }}
        />
      )}
      {/* Comparison legend — names both series whenever a ghost is present; the comparison chip is a
          toggle (steep #9): click to hide/show the overlay. Where a page-level compare control already
          owns the on/off (legendToggle=false, the metric page) the chip is a static label instead. */}
      {hasGhost && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-2xs font-medium text-muted-foreground">
          <span className="flex select-none items-center gap-1.5">
            <span aria-hidden="true" className="h-2 w-3 rounded-sm" style={{ backgroundColor: 'hsl(var(--chart-role-primary))' }} />
            {primaryLabel === 'Текущий' ? 'Текущий период' : primaryLabel}
          </span>
          {legendToggle ? (
            <button
              type="button"
              aria-pressed={!ghostHidden}
              onClick={() => setGhostHidden((v) => !v)}
              title={ghostHidden ? 'Показать сравнение' : 'Скрыть сравнение'}
              className={`flex select-none items-center gap-1.5 rounded transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40 ${ghostHidden ? 'opacity-40 line-through' : ''}`}
            >
              {/* Свотч-прямоугольник: сравнение здесь рисуется столбцами, не пунктиром, и свотч
                  повторяет ровно ту же альфу (GHOST_FILL), что и сами столбцы. */}
              <span aria-hidden="true" className="h-2 w-3 rounded-sm" style={{ backgroundColor: GHOST_FILL }} />
              {ghostLabel}
            </button>
          ) : (
            <span className="flex select-none items-center gap-1.5">
              <span aria-hidden="true" className="h-2 w-3 rounded-sm" style={{ backgroundColor: GHOST_FILL }} />
              {ghostLabel}
            </span>
          )}
        </div>
      )}
      {/* Readout anchored to the hovered bar's top-center (not the cursor) */}
      <ChartTooltip tip={hover && hover.i < n ? buildTip(hover.i) : null} appearance={appearance} />
    </div>
  );
}
