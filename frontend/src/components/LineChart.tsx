import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { EmptyState } from '@/components/EmptyState';
import { fmt } from '@/lib/format';
import { detectAnomalies } from '@/lib/anomaly';
import { nearestPointIndex } from '@/lib/chartHover';
import { axisLabelIndexes } from '@/lib/chartLabels';
import { ChartTooltip, type TooltipRow, type TooltipState } from '@/components/ChartTooltip';
import { ChartExpandedContext, ChartRefLinesContext, ExpandedChartHeightContext, WidgetTargetContext } from '@/components/ExpandableChart';
import { observeSize } from '@/lib/observeSize';

interface LineChartProps {
  /** Значения серии; null = день без данных (сбор пропущен) — рисуется РАЗРЫВОМ линии, а не
      нулём: ноль-которого-не-было — ложь дашборда (выдуманный обвал). */
  values: Array<number | null>;
  labels?: string[];
  titles?: string[];
  yMin?: number;
  yMax?: number;
  height?: number;
  /** Overlay hollow amber rings on statistically unusual points (local-outlier detection). */
  markAnomalies?: boolean;
  /** Comparison series (previous period / baseline), drawn dashed in the contrast colour
      (--chart-2) on the same y-scale, with a built-in legend row under the chart.
      null здесь — тот же «день без сбора»: в пунктире разрыв, строка сравнения в ховере
      не показывается (гарды `!= null` сохранены). */
  ghost?: Array<number | null>;
  /** Legend name for the ghost series (default «Прошлый период»). */
  ghostLabel?: string;
  /** Legend/tooltip name for the PRIMARY series. Default keeps the compare-семантику («Текущий
      период»/«Текущий»); pass a name when the ghost is a параллельная серия, а не прошлый период
      (например «Новые» vs «Повторные» на клиентской странице МС). */
  primaryLabel?: string;
  /** Show a percentage delta between primary and ghost. Disable for parallel categories. */
  comparisonDelta?: boolean;
  /** Metric-aware tooltip formatting; axes remain numeric. */
  formatValue?: (value: number) => string;
  /** Bare value labels at the max point and the last point (no pills — Refined Technical). */
  markExtremes?: boolean;
  /** Hollow rings on every data point (steep-style reading aid for daily series). */
  showPoints?: boolean;
  /** Force the full y-axis (nice ticks + gridlines + label gutter) regardless of the
      expanded context. Without it, dashboard cards render axis-free (steep-style). */
  fullAxes?: boolean;
  /** When set, data points become clickable (a drilldown gesture — e.g. open the metric page):
      a click anywhere on the chart fires this with the nearest point index and shows a pointer
      cursor. Hover behaviour is unchanged; left unset the chart is hover-only as before. */
  onPointClick?: (index: number) => void;
  /** Whether the comparison legend chip is an interactive show/hide toggle (default). Pass false
      where a page-level compare control already owns turning the comparison on/off (the metric
      page) — there the chip renders as a static label so the two controls can't desync. */
  legendToggle?: boolean;
  /** PINNED point (steep): a persistent dashed crosshair + solid marker at this index, set by
      the host page from onPointClick — the anchor for a «этот день» panel. null/undefined = off. */
  pinnedIndex?: number | null;
  /** Per-point titles for the STRUCTURED hover card (weekday-prefixed dates on the metric page);
      falls back to `labels`. The plain-text tooltip keeps reading `titles`. */
  hoverTitles?: string[];
  /** The comparison series' OWN calendar labels per point — joined into its hover row, so the
      compared value carries its real date («Пред. период · вт, 18 июн» — артефакт v2). */
  ghostTitles?: string[];
  /** Event flags (chart_annotations): ⚑ markers at these indices near the plot bottom; the label
      joins the hover readout of that point. Host page maps days → indices. */
  flags?: Array<{ i: number; label: string }>;
}

interface Hover {
  i: number;
}

// Approximate glyph width of the 11px tabular numerals used for axis/value labels.
const CHAR_W = 6.6;

/** Next step up the 1-2-5×10ⁿ ladder (20 → 50 → 100 → 200 …). */
function nextStep(step: number): number {
  const mag = 10 ** Math.floor(Math.log10(step));
  const n = Math.round(step / mag);
  return n < 2 ? 2 * mag : n < 5 ? 5 * mag : 10 * mag;
}

/**
 * Nice y-scale: snap the domain outward to 1/2/5×10ⁿ tick steps so gridlines land on round
 * values and never format into duplicate labels («4.9k / 4.9k / 4.8k»), capped at 5 ticks.
 */
export function niceScale(minV: number, maxV: number): { lo: number; hi: number; step: number; ticks: number[] } {
  let span = maxV - minV;
  if (!Number.isFinite(span) || span <= 0) span = Math.abs(maxV) || 1;
  const mag0 = 10 ** Math.floor(Math.log10(Math.max(span / 2.5, 1e-9)));
  const norm0 = span / 2.5 / mag0;
  let step = (norm0 >= 5 ? 5 : norm0 >= 2 ? 2 : 1) * mag0;
  let lo = Math.floor(minV / step) * step;
  let hi = Math.ceil(maxV / step) * step;
  while ((hi - lo) / step > 4.5) {
    step = nextStep(step);
    lo = Math.floor(minV / step) * step;
    hi = Math.ceil(maxV / step) * step;
  }
  if (hi === lo) hi = lo + step;
  const ticks: number[] = [];
  for (let t = hi; t >= lo - step / 2; t -= step) ticks.push(t);
  return { lo, hi, step, ticks };
}

/**
 * Tick label with step-aware precision: k/M abbreviation only when the step itself is coarse
 * enough to stay distinct after rounding; sub-thousand steps on a thousands scale print full
 * grouped integers (4 950), because «4.9k / 4.9k» would collide.
 */
export function axisLabel(v: number, step: number): string {
  if (Math.abs(v) < 1e-9) return '0';
  if (step >= 1000 || Math.abs(v) < 1000) return fmt.short(v);
  return fmt.num(v);
}

export function LineChart({
  values,
  labels,
  titles,
  yMin,
  yMax,
  height,
  markAnomalies,
  ghost,
  ghostLabel = 'Прошлый период',
  primaryLabel,
  comparisonDelta = true,
  formatValue = fmt.num,
  markExtremes = false,
  showPoints = false,
  fullAxes = false,
  onPointClick,
  legendToggle = true,
  pinnedIndex = null,
  hoverTitles,
  ghostTitles,
  flags,
}: LineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Press position (client px) for the drag guard — see onSvgClick below.
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  // The comparison series can be toggled off via its legend chip (steep #9) — a decluttering
  // reading aid. Hidden, it also drops out of the y-domain below so the current series
  // reclaims the full height.
  const [ghostHidden, setGhostHidden] = useState(false);
  // A freshly-enabled or changed comparison always starts SHOWN: reset the manual hide when the
  // ghost's content changes (compare turned on, or the metric/route swapped the series). Keyed on a
  // content signature — not array identity — so a referentially-unstable-but-equal re-render (a
  // refetch producing an identical series) never resets it, which would make the chip un-clickable.
  const ghostKey = ghost && ghost.length >= 2 ? ghost.join(',') : '';
  const prevGhostKey = useRef(ghostKey);
  useEffect(() => {
    if (ghostKey === prevGhostKey.current) return;
    prevGhostKey.current = ghostKey;
    if (ghostKey) setGhostHidden(false);
  }, [ghostKey]);
  // Measure the real render width so the viewBox is 1:1 with CSS pixels — otherwise a
  // fixed 600-wide viewBox stretched to a wide container magnifies text + markers 2-3×.
  const [width, setWidth] = useState(600);
  // Dashboard cards are axis-free sparkline-style reads (steep); the expanded overlay and
  // metric pages provide the context (or set fullAxes) for the full nice-tick y-axis.
  const expanded = useContext(ChartExpandedContext);
  const refLines = useContext(ChartRefLinesContext);
  const ctxHeight = useContext(ExpandedChartHeightContext);
  // Per-widget goal line («Целевой уровень»): provided by ChartSection, null everywhere else.
  const targetCtx = useContext(WidgetTargetContext);
  const target = targetCtx != null && Number.isFinite(targetCtx) ? targetCtx : null;
  const showAxes = fullAxes || expanded;
  // Strip colons from useId — valid in ids, but break SVG url(#…) refs in some browsers.
  const gradientId = `lc${useId().replace(/:/g, '')}`;

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth || 600);
    measure();
    return observeSize(el, measure);
  }, []);

  // The readout must not linger once the chart scrolls under the sticky header or the
  // window loses focus — mouseleave alone does not fire during wheel scrolling.
  const hasHover = hover !== null;
  useEffect(() => {
    if (!hasHover) return;
    const clear = () => setHover(null);
    window.addEventListener('scroll', clear, true);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('scroll', clear, true);
      window.removeEventListener('blur', clear);
    };
  }, [hasHover]);

  // Anomaly detection is O(n·window) statistics — memoized on the series so hover-driven
  // re-renders don't re-run it. Before the early return to keep the hook order stable.
  // Детектор принимает только number[]: null подставляем нулём для расчёта, но флаги на
  // null-индексах отбрасываем — «аномалия» в дыре была бы артефактом подстановки, не данными.
  const anomalyIdx = useMemo(() => {
    if (!markAnomalies || !values || values.length < 2) return [];
    return detectAnomalies(values.map((v) => v ?? 0)).filter((i) => values[i] != null);
  }, [markAnomalies, values]);

  // Toggled off (or absent), the comparison drops out of every draw/measure below; the legend
  // chip stays visible so it can be toggled back on. Derived before the plot memo (its inputs).
  const hasGhostLegend = !!ghost && ghost.length >= 2;
  const showGhost = hasGhostLegend && !ghostHidden;
  const activeGhost = showGhost ? ghost : undefined;

  // ── Geometry + the static plot, memoized APART from hover ────────────────────────────────
  // Hover is a per-mousemove setState: without this memo every crosshair step re-derived the
  // scale, rebuilt every path string and re-created the whole element tree. Now a hover
  // re-render reuses this cached subtree (React bails out on the identical element) and draws
  // only the crosshair overlay below — and the per-point transparent hit-rects are gone
  // entirely (a 365-point series × a board of cards used to be thousands of hover-only nodes);
  // the svg carries ONE mouse handler and the index is O(1) math (nearestPointIndex).
  const plot = useMemo(() => {
    if (!values) return null;
    // Реальные (non-null) точки: null-день = «сбор пропущен», он не участвует ни в домене,
    // ни в путях — нарисовать его нулём значит выдумать обвал, которого не было.
    const real: Array<{ i: number; v: number }> = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v != null) real.push({ i, v });
    }
    // Меньше двух реальных точек — графика нет: дыры данными не считаются.
    if (real.length < 2) return null;

    // In a fixed-height card tile (ctxHeight = the tile's leftover height, and NOT the expanded
    // overlay), the svg shares the tile with the HTML rows drawn below it — the minimal x-label
    // row and/or the comparison legend. Reserve their height so svg + rows fit the tile exactly:
    // no inner scrollbar, no clipped axis. Outside a tile (ctxHeight null → content-height card,
    // or the expanded overlay where labels live inside the svg) nothing is reserved.
    const X_LABEL_ROW_H = 22;
    const LEGEND_ROW_H = 22;
    const hasXAxis = showAxes && !!labels && labels.length === values.length;
    const belowRows =
      ctxHeight != null && !expanded
        ? (labels && labels.length > 0 && !hasXAxis ? X_LABEL_ROW_H : 0) +
          (hasGhostLegend ? LEGEND_ROW_H : 0)
        : 0;
    const h = Math.max((ctxHeight ?? height ?? 200) - belowRows, 80);
    const W = Math.max(width, 1);
    const padR = 10;
    const padY = 12;
    // Real x-axis (tick marks + date labels INSIDE the svg) in axes mode — the explorer/metric
    // reading. Needs a taller bottom band; the axis-free cards keep the symmetric pad and the
    // minimal first/mid/last HTML row below the svg. Requires PER-POINT labels (one per value);
    // legacy 3-label arrays can't be positioned on the axis and keep the HTML row instead.
    const padB = hasXAxis ? 30 : padY;

    // Domain covers the series, the (shown) ghost and the target — a goal above the data must
    // be visible. Только non-null: null в Math.min/max превратился бы в 0 — ложный «пол» домена.
    const scaleVals = [
      ...real.map((r) => r.v),
      ...(activeGhost ?? []).filter((v): v is number => v != null),
      ...(target != null ? [target] : []),
    ];
    const computedMin = Math.min(...scaleVals);
    const computedMax = Math.max(...scaleVals);
    // The caller's yMin/yMax (e.g. a zero base for volume metrics) defines the domain; the nice
    // scale then only expands it outward to round tick values, never clips.
    const scale = niceScale(yMin ?? computedMin, yMax ?? computedMax);
    const min = scale.lo;
    const max = scale.hi;
    const range = max - min || 1;

    const yFor = (v: number) => h - padB - ((v - min) / range) * (h - padY - padB);
    // Full-axes mode only: nice ticks deduped belt-and-braces (drop any tick whose formatted
    // label repeats the previous one). Minimal mode renders no ticks/gridlines at all.
    const yAxis = showAxes
      ? scale.ticks
          .map((v) => ({ v, label: axisLabel(v, scale.step) }))
          .filter((tick, i, arr) => i === 0 || tick.label !== arr[i - 1].label)
      : [];
    const yGridPositions = yAxis.map((t) => yFor(t.v));
    const yLabels = yAxis.map((t) => t.label);
    // Left gutter reserved for the y labels (right-aligned inside it) so they never sit
    // on the line/area and the first label is never clipped by the container edge.
    // Axis-free mode keeps only a sliver so edge markers (rings) don't clip on the viewBox.
    const gutterW = showAxes
      ? Math.max(28, Math.round(Math.max(...yLabels.map((l) => l.length)) * CHAR_W) + 14)
      : 6;

    const n = values.length;
    const plotW = Math.max(W - gutterW - padR, 10);
    const step = plotW / Math.max(n - 1, 1);

    // y = null у дыры: x сохраняем — он нужен ховеру, пину и флажкам, а рисовать нечего.
    const points = values.map((v, i) => {
      const x = gutterW + i * step;
      return { x, y: v != null ? yFor(v) : null, v };
    });

    // Маркер «сейчас» — последняя РЕАЛЬНАЯ точка: хвостовая дыра не должна вешать его в пустоту.
    const lastReal = real[real.length - 1];
    const lastPt = { x: points[lastReal.i].x, y: yFor(lastReal.v) };
    // Начало серии — ПОЛАЯ точка (steep): полюса линии размечены парой «прокол → сплошная»,
    // взгляд сразу считывает направление чтения. Тоже первая РЕАЛЬНАЯ точка.
    const firstReal = real[0];
    const firstPt = { x: points[firstReal.i].x, y: yFor(firstReal.v) };

    // Линия и заливка — СЕГМЕНТАМИ по непрерывным run'ам реальных точек: дыра = честный разрыв,
    // интерполяция «через пропуск» нарисовала бы данные, которых не было.
    const segs: Array<Array<{ x: number; y: number }>> = [];
    let run: Array<{ x: number; y: number }> = [];
    for (const p of points) {
      if (p.y == null) {
        if (run.length > 0) {
          segs.push(run);
          run = [];
        }
      } else {
        run.push({ x: p.x, y: p.y });
      }
    }
    if (run.length > 0) segs.push(run);
    const lineSegs = segs.filter((s) => s.length >= 2);
    // Один path с подпутями M…L… — stroke остаётся одним элементом, разрывы честные.
    const linePath = lineSegs.map((s) => s.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')).join(' ');
    // Каждый сегмент заливки замыкается на СВОЮ базовую линию — дыра остаётся незакрашенной.
    const baseY = h - padB;
    const areaPath = lineSegs
      .map((s) => `${s.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')} L ${s[s.length - 1].x} ${baseY} L ${s[0].x} ${baseY} Z`)
      .join(' ');
    // Сегмент из одной точки: точка-кружок — единственное измерение между дырами всё равно факт,
    // а линия нулевой длины была бы невидима.
    const lonePts = segs.filter((s) => s.length === 1).map((s) => s[0]);

    // Ghost-дыры тоже не выдумываем: null = pen-up, следующий реальный отсчёт открывает новый
    // подпуть — тот же честный разрыв, что у основной серии (раньше null коэрсился бы в 0).
    const ghostPath =
      activeGhost && activeGhost.length >= 2
        ? (() => {
            let d = '';
            let pen = false;
            for (let i = 0; i < activeGhost.length; i++) {
              const v = activeGhost[i];
              if (v == null) {
                pen = false;
                continue;
              }
              d += `${d ? ' ' : ''}${pen ? 'L' : 'M'} ${gutterW + i * step} ${yFor(v)}`;
              pen = true;
            }
            return d;
          })()
        : '';

    // Real x-axis ticks (axes mode): width-aware stride so labels never collide — one label
    // by measured width, always including the first and the last point.
    const xTicks = hasXAxis
      ? (() => {
          return axisLabelIndexes(n, plotW, { minLabelPx: expanded ? 76 : 88, maxLabels: expanded ? 12 : 8 })
            .map((i) => {
              const text = labels?.[i] ?? '';
              if (!text) return null;
              const halfW = (text.length * CHAR_W) / 2;
              const x = Math.min(Math.max(points[i].x, gutterW + halfW), Math.max(W - padR - halfW, gutterW + halfW));
              return { i, px: points[i].x, x, text };
            })
            .filter((t): t is { i: number; px: number; x: number; text: string } => t !== null);
        })()
      : [];

    // Bare value labels at the max point and the last point (deduped when they coincide),
    // placed above the point and flipped below when the top edge would clip them, clamped
    // into the plot area horizontally.
    const extremes = (() => {
      if (!markExtremes) return [];
      // Max и «последнее» — только по реальным точкам: подписывать дыру нечем.
      let maxE = real[0];
      for (const r of real) if (r.v > maxE.v) maxE = r;
      const idxs = maxE.i === lastReal.i ? [lastReal] : [maxE, lastReal];
      return idxs.map((e) => {
        const px = points[e.i].x;
        const py = yFor(e.v);
        const text = fmt.short(e.v);
        const halfW = (text.length * CHAR_W) / 2;
        // +6px воздуха справа: лейбл последней точки не прилипает к краю карточки.
        const x = Math.min(Math.max(px, gutterW + halfW), Math.max(W - padR - halfW - 6, gutterW + halfW));
        const fitsAbove = py - 18 >= 0;
        const y = fitsAbove ? py - 8 : py + 16;
        return { key: e.i, x, y, text };
      });
    })();

    const staticLayer = (
      <>
        <defs>
          {/* Area fill — FLAT, even tint (Steep-noble): NO vertical gradient wash. One low opacity
              from the line to the baseline reads as a calm solid fill, not a fading glow (both stops
              share the opacity → deliberately flat). The expanded explorer is quieter still. On a
              tinted card the fill just deepens the accent evenly, keeping the whole tile monochrome. */}
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--chart-role-primary))" stopOpacity={expanded ? '0.05' : '0.12'} />
            <stop offset="100%" stopColor="hsl(var(--chart-role-primary))" stopOpacity={expanded ? '0.05' : '0.12'} />
          </linearGradient>
        </defs>

        {/* Gridlines — start after the label gutter */}
        {yGridPositions.map((yPos, idx) => (
          <line key={idx} x1={gutterW} y1={yPos} x2={W} y2={yPos} stroke="hsl(var(--border))" strokeDasharray="4 6" strokeWidth="1" opacity="0.6" vectorEffect="non-scaling-stroke" />
        ))}

        {/* Large explorer plots need a vertical rhythm as well: it makes the grid a clear hover
            target and keeps dates aligned with their values across a wide canvas. */}
        {xTicks.map((tick) => (
          <line
            key={`grid-x${tick.i}`}
            x1={tick.px}
            y1={padY}
            x2={tick.px}
            y2={h - padB}
            stroke="hsl(var(--border))"
            strokeDasharray="4 6"
            strokeWidth="1"
            opacity="0.38"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {/* Comparison series — the comparison role (deep amber, the colour-blind-safe pair of the
            brand blue), dashed, same y-scale. The legend row under the chart names both series. */}
        {ghostPath && (
          <path d={ghostPath} fill="none" stroke="hsl(var(--chart-role-comparison))" strokeWidth="1.8" strokeDasharray="5 4" opacity="0.8" vectorEffect="non-scaling-stroke" />
        )}

        {/* Target level (widget pref) — a dashed goal line with a small right-aligned label */}
        {target != null && (
          <>
            <line x1={gutterW} y1={yFor(target)} x2={W} y2={yFor(target)} stroke="hsl(var(--chart-role-neutral))" strokeDasharray="6 4" strokeWidth="1.2" opacity="0.8" vectorEffect="non-scaling-stroke" />
            <text
              x={W - 4}
              y={yFor(target) - 4 < 10 ? yFor(target) + 12 : yFor(target) - 4}
              textAnchor="end"
              className="pointer-events-none select-none fill-muted-foreground text-2xs font-medium tabular-nums"
            >
              цель {fmt.short(target)}
            </text>
          </>
        )}

        {/* Min/Max/Average reference lines (overlay «Линии» toggle) — dashed hairlines at the visible
            extremes + mean, read faster than the numeric stats strip. Drawn under the series line. */}
        {refLines && (
          <>
            {([['макс', refLines.max], ['сред.', refLines.avg], ['мин', refLines.min]] as const).map(([lbl, v]) => (
              <g key={lbl} className="pointer-events-none">
                <line x1={gutterW} y1={yFor(v)} x2={W} y2={yFor(v)} stroke="hsl(var(--chart-role-neutral))" strokeDasharray="6 4" strokeWidth="1.2" opacity="0.7" vectorEffect="non-scaling-stroke" />
                <text
                  x={W - 4}
                  y={yFor(v) - 4 < 10 ? yFor(v) + 12 : yFor(v) - 4}
                  textAnchor="end"
                  className="pointer-events-none select-none fill-muted-foreground text-2xs font-medium tabular-nums"
                >
                  {lbl} {fmt.short(v)}
                </text>
              </g>
            ))}
          </>
        )}

        {/* Gradient area + line — сегментами (пустой d не рендерим: серия может быть
            россыпью одиночных измерений без единого сплошного отрезка) */}
        {areaPath && <path d={areaPath} fill={`url(#${gradientId})`} />}
        {linePath && (
          <path d={linePath} fill="none" stroke="hsl(var(--chart-role-primary))" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        )}

        {/* Одиночное измерение между дырами — точка вместо невидимой линии нулевой длины */}
        {lonePts.map((p) => (
          <circle key={`lone${p.x}`} cx={p.x} cy={p.y} r="2.5" fill="hsl(var(--chart-role-primary))" className="pointer-events-none" />
        ))}

        {/* Per-point hollow rings (steep-style) — knocked out from the paper so the line reads
            as a dotted sequence of measurements, not a continuous estimate. Дыры пропускаем. */}
        {showPoints &&
          points.map((p, i) =>
            p.y != null ? (
              <circle key={`pt${i}`} cx={p.x} cy={p.y} r="3" fill="hsl(var(--background))" stroke="hsl(var(--chart-role-primary))" strokeWidth="1.5" vectorEffect="non-scaling-stroke" className="pointer-events-none" />
            ) : null,
          )}

        {/* Anomaly markers — hollow amber rings on statistically unusual points */}
        {anomalyIdx.map((i) => {
          const p = points[i];
          // Гард на дыру: кольцу аномалии без значения некуда встать.
          return p && p.y != null ? (
            <circle key={`a${i}`} cx={p.x} cy={p.y} r="5" fill="none" stroke="hsl(var(--chart-role-warning))" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          ) : null;
        })}

        {/* Полюса линии (steep): начало — полая точка, конец — сплошной маркер «сейчас».
            Оба стоят на РЕАЛЬНЫХ точках: краевые дыры маркеров не получают. */}
        <circle cx={firstPt.x} cy={firstPt.y} r="3.5" fill="hsl(var(--background))" stroke="hsl(var(--chart-role-primary))" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <circle cx={lastPt.x} cy={lastPt.y} r="4" fill="hsl(var(--chart-role-primary))" stroke="hsl(var(--background))" strokeWidth="2" vectorEffect="non-scaling-stroke" />

        {/* Max / last value labels (markExtremes) — bare tabular text, no boxes */}
        {extremes.map((e) => (
          <text key={`e${e.key}`} x={e.x} y={e.y} textAnchor="middle" className="pointer-events-none select-none fill-ink2 text-2xs font-medium tabular-nums">
            {e.text}
          </text>
        ))}

        {/* Y-axis labels — right-aligned in the reserved gutter */}
        {yGridPositions.map((yPos, idx) => (
          <text key={idx} x={gutterW - 8} y={yPos + 3.5} textAnchor="end" className="pointer-events-none select-none fill-muted-foreground text-2xs font-medium tabular-nums">
            {yLabels[idx]}
          </text>
        ))}

        {/* X-axis (axes mode) — tick marks + date labels inside the bottom band */}
        {xTicks.map((t) => (
          <g key={`x${t.i}`}>
            <line x1={t.px} y1={h - padB + 3} x2={t.px} y2={h - padB + 7} stroke="hsl(var(--border))" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <text x={t.x} y={h - 8} textAnchor="middle" data-chart-axis-label="x" className="pointer-events-none select-none fill-muted-foreground text-2xs font-medium tabular-nums">
              {t.text}
            </text>
          </g>
        ))}
      </>
    );

    return { W, h, gutterW, step, points, yFor, hasXAxis, plotTop: padY, plotBottom: h - padB, staticLayer };
  }, [values, labels, activeGhost, hasGhostLegend, target, refLines, yMin, yMax, width, ctxHeight, height, expanded, showAxes, markExtremes, showPoints, anomalyIdx, gradientId]);

  // Пустое состояние считается по РЕАЛЬНЫМ точкам (plot = null при < 2 non-null): серия из
  // одних null-дней — честное «нет данных», а не нулевая линия.
  if (!plot) {
    return (
      <EmptyState compact title="Нет данных за период" className="flex h-40 items-center justify-center" />
    );
  }

  const { W, h, gutterW, step, points, yFor, hasXAxis, plotTop, plotBottom } = plot;
  const n = values.length;
  // Для ARIA-подписи: max и «последнее» — только по реальным значениям (дыра не значение).
  const realValues = values.filter((v): v is number => v != null);
  const anomalySet = new Set(anomalyIdx);

  const flagMap = new Map((flags ?? []).map((f) => [f.i, f.label] as const));
  const tipText = (i: number, v: number) => {
    let base = titles?.[i] ?? fmt.num(v);
    // Hovering a compared chart reads both series at once (comparison shown).
    // Локал вместо activeGhost[i]: сужение element-access по индексу TS не гарантирует.
    const gv = activeGhost?.[i];
    if (gv != null) base = `${base} · пред. ${fmt.num(gv)}`;
    if (anomalySet.has(i)) base = `${base} · аномалия`;
    const fl = flagMap.get(i);
    return fl ? `${base} · ⚑ ${fl}` : base;
  };
  // Structured-card title: weekday-prefixed date (hoverTitles) + anomaly + event flag markers.
  const cardTitle = (i: number) => {
    const parts: string[] = [hoverTitles?.[i] ?? labels?.[i] ?? ''];
    if (anomalySet.has(i)) parts.push('аномалия');
    const fl = flagMap.get(i);
    if (fl) parts.push(`⚑ ${fl}`);
    return parts.filter(Boolean).join(' · ');
  };
  // The hover readout: a STRUCTURED card (date · Текущий · comparison · Δ) whenever a ghost series
  // is present — so the tooltip is an instrument, not a caption. Without a comparison, keep the
  // metric's own rich title text (velocity/history carry extra context there).
  const buildTip = (i: number): TooltipState => {
    const p = points[i];
    const v = values[i];
    // День-дыра: ВСЕГДА plain-text «данных нет» — rows/ghost/titles нарисовали бы значение,
    // которого не существует. Якорь — середина плота (своего y у дыры нет).
    if (v == null) {
      return { x: p.x, y: (plotTop + plotBottom) / 2, text: `${labels?.[i] ?? ''}: данных нет — сбор пропущен` };
    }
    const py = yFor(v);
    // Тот же приём с локалом: prev != null сужает до number, дальше арифметика безопасна.
    const prev = activeGhost?.[i];
    if (prev != null) {
      const cur = v;
      const rows: TooltipRow[] = [
        { label: primaryLabel ?? 'Текущий', value: formatValue(cur), color: 'hsl(var(--chart-role-primary))' },
        {
          // Своя дата у строки сравнения (артефакт v2): «Пред. период · вт, 18 июн».
          label: ghostTitles?.[i] ? `${ghostLabel} · ${ghostTitles[i]}` : ghostLabel,
          value: formatValue(prev),
          color: 'hsl(var(--chart-role-comparison))',
        },
      ];
      const d = prev !== 0 ? ((cur - prev) / Math.abs(prev)) * 100 : null;
      if (comparisonDelta && d != null && Number.isFinite(d)) rows.push({ label: 'Δ', value: `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}%` });
      return { x: p.x, y: py, title: cardTitle(i), rows };
    }
    if (expanded) {
      const rows: TooltipRow[] = [
        {
          label: 'Текущий период',
          value: formatValue(v),
          color: 'hsl(var(--chart-role-primary))',
        },
      ];
      return { x: p.x, y: py, title: cardTitle(i), rows };
    }
    return { x: p.x, y: py, text: tipText(i, v) };
  };

  // ONE hit surface: the svg itself. The pointer x maps to the nearest point in O(1); moving
  // within a point's zone keeps the same state object, so those mousemoves don't re-render.
  const indexFromEvent = (e: ReactMouseEvent<SVGSVGElement>): number | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return null;
    const xView = ((e.clientX - rect.left) / rect.width) * W;
    return nearestPointIndex(xView, n, gutterW, step);
  };
  const onSvgMove = (e: ReactMouseEvent<SVGSVGElement>) => {
    const i = indexFromEvent(e);
    if (i == null) return;
    setHover((prev) => (prev && prev.i === i ? prev : { i }));
  };
  // Drill only on a genuine click, not a press-drag-release scrub (the browser retargets a
  // cross-point click to the svg — without this guard a drag-to-read gesture would navigate). A
  // click with no recorded press (keyboard / AT) passes through.
  const onSvgClick = onPointClick
    ? (e: ReactMouseEvent<SVGSVGElement>) => {
        const press = pressRef.current;
        pressRef.current = null;
        if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5) return;
        const i = indexFromEvent(e);
        if (i != null) {
          // The chart OWNS this click (point drill / pin) — don't let it bubble into the host
          // card's whole-card expand, which would double-act on one tap.
          e.stopPropagation();
          onPointClick(i);
        }
      }
    : undefined;
  const clearHover = () => {
    pressRef.current = null;
    setHover(null);
  };

  const hovered = hover && hover.i < n ? points[hover.i] : null;
  // Ghost-точка под курсором: считаем локалом заранее — element-access в JSX TS не сужает.
  const hoverGhostVal = hover && activeGhost ? activeGhost[hover.i] : null;
  const hoverGhostY = hoverGhostVal != null ? yFor(hoverGhostVal) : null;
  // Пин на дыре: вертикаль остаётся (день-то выбран), solid-маркер — только у реальной точки.
  const pinnedPt = pinnedIndex != null && pinnedIndex >= 0 && pinnedIndex < n ? points[pinnedIndex] : null;
  const compactLabelIndexes =
    labels && labels.length > 0 && !hasXAxis
      ? axisLabelIndexes(labels.length, W, { minLabelPx: 92, maxLabels: expanded ? 8 : 5 })
      : [];

  return (
    <div
      ref={containerRef}
      className="relative w-full"
      onMouseLeave={clearHover}
      onPointerLeave={clearHover}
    >
      <svg
        data-chart-kind="line"
        data-chart-expanded={expanded ? '' : undefined}
        className={`block w-full ${onPointClick ? 'cursor-pointer' : 'cursor-crosshair'}`}
        height={h}
        viewBox={`0 0 ${W} ${h}`}
        preserveAspectRatio="none"
        // A named graphic for AT (PieChart idiom): role="img" stops screen readers from announcing
        // the raw axis <text> ticks as loose numbers, and the label carries the data a mouse user
        // reads from hover (per-point keyboard access is a separate roadmap item). Math.max over
        // the SERIES — the in-scope `max` is the padded nice-scale top, not the data max.
        // Только реальные значения: null-дыра не участвует ни в max, ни в «последнем».
        role="img"
        aria-label={`График: ${values.length} точек, макс ${fmt.short(Math.max(...realValues))}, последнее ${fmt.short(realValues[realValues.length - 1])}`}
        onMouseMove={onSvgMove}
        onMouseDown={onPointClick ? (e) => (pressRef.current = { x: e.clientX, y: e.clientY }) : undefined}
        onClick={onSvgClick}
      >
        {plot.staticLayer}

        {/* Событ/annotation flags (артефакт v2 п.7): ⚑ у нижней кромки + пунктир к точке дня;
            подпись события читается в ховер-карточке этого дня. */}
        {flagMap.size > 0 && (
          <g className="pointer-events-none">
            {[...flagMap.keys()]
              .filter((i) => i >= 0 && i < n)
              .map((i) => {
                const p = points[i];
                return (
                  <g key={`fl${i}`}>
                    {/* Пунктир-коннектор — только к реальной точке: в дыру его тянуть некуда. */}
                    {p.y != null && (
                      <line
                        x1={p.x}
                        y1={p.y + 6}
                        x2={p.x}
                        y2={plotBottom - 15}
                        stroke="hsl(var(--border))"
                        strokeWidth="1"
                        strokeDasharray="1 3"
                        vectorEffect="non-scaling-stroke"
                      />
                    )}
                    <circle cx={p.x} cy={plotBottom - 8} r="7" fill="hsl(var(--popover))" stroke="hsl(var(--border))" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                    <text x={p.x} y={plotBottom - 4.5} textAnchor="middle" className="select-none fill-muted-foreground text-2xs">
                      ⚑
                    </text>
                  </g>
                );
              })}
          </g>
        )}

        {/* PINNED point — persistent dashed crosshair + solid marker (under the live hover). */}
        {pinnedPt && (
          <g className="pointer-events-none">
            <line
              x1={pinnedPt.x}
              y1={plotTop}
              x2={pinnedPt.x}
              y2={plotBottom}
              stroke="hsl(var(--chart-role-selection))"
              strokeWidth="1.5"
              strokeDasharray="2 3"
              opacity="0.6"
              vectorEffect="non-scaling-stroke"
            />
            {/* Solid-маркер — только у реальной точки: у дыры нет значения, куда его ставить. */}
            {pinnedPt.y != null && (
              <circle cx={pinnedPt.x} cy={pinnedPt.y} r="4.5" fill="hsl(var(--chart-role-selection))" stroke="hsl(var(--background))" strokeWidth="2" />
            )}
          </g>
        )}

        {/* Hovered-point crosshair + marker (+ the comparison point at the same x, so hovering
            reads BOTH series) — the only elements a hover re-render touches. */}
        {hovered && (
          <>
            <line
              data-chart-crosshair
              x1={hovered.x}
              y1={plotTop}
              x2={hovered.x}
              y2={plotBottom}
              stroke="hsl(var(--chart-role-selection))"
              strokeWidth="1.25"
              strokeDasharray="3 4"
              opacity="0.72"
              vectorEffect="non-scaling-stroke"
            />
            {/* На null-дне маркеров нет (ни текущего, ни ghost): точка-призрак у несуществующего
                значения — та же ложь, что и ноль; остаётся только вертикаль + «данных нет». */}
            {hovered.y != null && hoverGhostY != null && (
              <circle cx={hovered.x} cy={hoverGhostY} r="3.5" fill="hsl(var(--card))" stroke="hsl(var(--chart-role-comparison))" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            )}
            {hovered.y != null && (
              <circle cx={hovered.x} cy={hovered.y} r="4" fill="hsl(var(--chart-role-selection))" stroke="hsl(var(--background))" strokeWidth="1.5" />
            )}
          </>
        )}
      </svg>

      {/* Minimal x labels (axis-free cards): first / mid / last under the svg. Axes mode
          draws the real in-svg x-axis above instead. Метки ровные: бывшая акцент-пилюля
          последней метки (emphasizeLastLabel) снята продуктово — прод-фидбек: среди плоских
          соседок она читалась как залипший ховер, а не подсветка «сегодня». */}
      {labels && labels.length > 0 && !hasXAxis && (
        <div className="mt-1.5 flex select-none items-center justify-between gap-2 px-1 text-2xs font-medium text-muted-foreground">
          {compactLabelIndexes.map((i) => (
            <span key={i} data-chart-axis-label="x-compact" className="min-w-0 truncate">
              {labels[i]}
            </span>
          ))}
        </div>
      )}

      {/* Comparison legend — names both series whenever a ghost is present; the comparison chip is a
          toggle (steep #9): click to hide/show the ghost series (the current-period chip stays put,
          hiding the metric itself is meaningless). Where a page-level compare control already owns the
          on/off (legendToggle=false, the metric page) the chip is a static label instead. */}
      {ghost && ghost.length >= 2 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-2xs font-medium text-muted-foreground">
          <span className="flex select-none items-center gap-1.5">
            <span aria-hidden="true" className="h-0.5 w-4 rounded-full" style={{ backgroundColor: 'hsl(var(--chart-role-primary))' }} />
            {primaryLabel ?? 'Текущий период'}
          </span>
          {legendToggle ? (
            <button
              type="button"
              aria-pressed={!ghostHidden}
              onClick={() => setGhostHidden((v) => !v)}
              title={ghostHidden ? 'Показать сравнение' : 'Скрыть сравнение'}
              className={`flex select-none items-center gap-1.5 rounded transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${ghostHidden ? 'opacity-40 line-through' : ''}`}
            >
              <span aria-hidden="true" className="w-4 border-t-2 border-dashed" style={{ borderColor: 'hsl(var(--chart-role-comparison))' }} />
              {ghostLabel}
            </button>
          ) : (
            <span className="flex select-none items-center gap-1.5">
              <span aria-hidden="true" className="w-4 border-t-2 border-dashed" style={{ borderColor: 'hsl(var(--chart-role-comparison))' }} />
              {ghostLabel}
            </span>
          )}
        </div>
      )}

      {/* Readout anchored to the snapped data point (not the cursor) so it stays inside the chart */}
      <ChartTooltip tip={hovered ? buildTip(hover!.i) : null} />
    </div>
  );
}
