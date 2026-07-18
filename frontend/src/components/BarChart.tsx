import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { EmptyState } from '@/components/EmptyState';
import { fmt } from '@/lib/format';
import { columnIndex } from '@/lib/chartHover';
import { axisLabelIndexSet } from '@/lib/chartLabels';
import { ChartTooltip, type TooltipRow, type TooltipState } from '@/components/ChartTooltip';
import { axisLabel, niceScale } from '@/components/LineChart';
import { ChartExpandedContext, ChartRefLinesContext, ExpandedChartHeightContext, WidgetTargetContext } from '@/components/ExpandableChart';

interface BarChartProps {
  values: number[];
  labels?: string[];
  titles?: string[];
  height?: number;
  /** Comparison series (previous period / baseline), drawn as a dashed --chart-2 overlay
      line across the bar tops, with a legend row — the visual delta for bar charts. */
  ghost?: number[];
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

export function BarChart({ values, labels, titles, height = 200, ghost, primaryLabel = 'Текущий', ghostLabel = 'Прошлый период', comparisonDelta = true, formatValue = fmt.num, onPointClick, legendToggle = true, pinnedIndex = null }: BarChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Press position (client px) for the drag guard: the svg-level onClick would otherwise drill on
  // a press-drag-release scrub (the browser retargets a cross-child click to the svg). null = no
  // press recorded, so a keyboard/AT-synthesized click still passes through.
  const pressRef = useRef<{ x: number; y: number } | null>(null);
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
    const measure = () => setWidth(el.clientWidth || 600);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
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

  const hasGhost = !!ghost && ghost.length === values.length && ghost.length >= 2;
  // Toggled off, the comparison drops out of every draw/measure below; the legend chip stays
  // visible so it can be toggled back on. Derived before the plot memo (its inputs).
  const showGhost = hasGhost && !ghostHidden;
  const activeGhost = showGhost ? ghost : undefined;

  // ── Geometry + the static plot, memoized APART from hover ────────────────────────────────
  // Hover used to swap every bar's opacity and re-create the whole element tree per mousemove
  // (plus a transparent hit-rect per column). Now the bars render ONCE into a cached layer; the
  // hover dim is a single group-opacity attribute, the hovered bar is re-drawn at full opacity
  // in the overlay below, and the svg carries ONE mouse handler with O(1) column math.
  const plot = useMemo(() => {
    if (!values || values.length === 0) return null;

    // Expanded view: bars scale against a NICE domain top (1/2/5×10ⁿ) so the y ticks land on
    // round values, like LineChart — the old max/mid pair printed «262» next to «2.5k».
    // The domain also covers the target and the (shown) comparison line — both must stay visible.
    const rawMax = Math.max(...values, 1, target ?? 0, ...(activeGhost ?? []));
    const scale = expanded ? niceScale(0, rawMax) : null;
    const max = scale ? scale.hi : rawMax;
    const n = values.length;
    const chartWidth = Math.max(width, 1);
    // In a fixed-height card tile (ctxHeight set, not the expanded overlay), the comparison legend
    // is an HTML row BELOW the svg — reserve its height so svg + legend fit the tile with no inner
    // scrollbar. (X-labels are drawn INSIDE the svg via paddingBottom, so they need no reservation.)
    const legendRow = ctxHeight != null && !expanded && hasGhost ? 22 : 0;
    const chartHeight = Math.max((ctxHeight ?? height) - legendRow, 60);
    const paddingBottom = labels && labels.length > 0 ? 24 : 0;
    const graphHeight = chartHeight - paddingBottom;
    // Expanded view: headroom for the value labels above full-height bars.
    const padTop = expanded ? 18 : 0;
    const usable = Math.max(graphHeight - padTop, 1);

    // Expanded view: nice-tick labels right-aligned in a reserved left gutter (0 = baseline).
    const yTicks = scale ? scale.ticks.filter((t) => t > 0) : [];
    const tickLabels = yTicks.map((v) => axisLabel(v, scale ? scale.step : 1));
    const gutterW = expanded
      ? Math.max(28, Math.round(Math.max(...tickLabels.map((l) => l.length)) * CHAR_W) + 14)
      : 0;

    // Cap the column width and center the group when there are few bars.
    const plotW = Math.max(chartWidth - gutterW, 10);
    const itemWidth = Math.min(plotW / n, MAX_BAR_W / BAR_RATIO);
    const barWidth = itemWidth * BAR_RATIO;
    const offsetX = gutterW + (plotW - itemWidth * n) / 2;
    // Thin x-labels by measured width; labels are hidden rather than rotated in tight cards.
    const labelIndexes = axisLabelIndexSet(n, plotW, { minLabelPx: expanded ? 68 : 78, maxLabels: expanded ? 12 : 7 });

    const barTop = (val: number) => graphHeight - (val / max) * usable;
    const barCenterX = (i: number) => offsetX + i * itemWidth + itemWidth / 2;

    // Сравнение в СТОЛБЦАХ рисуется столбцами же (владелец: пунктирная линия поверх баров
    // «странно смотрится» — смешение языков форм). Группированные пары: прошлое слева
    // (приглушённый comparison-тон), текущее справа; 2px-зазор внутри пары (dataviz-канон).
    const GROUP_GAP = 2;
    const subW = activeGhost ? Math.max((barWidth - GROUP_GAP) / 2, 1) : barWidth;
    const bandX = (i: number) => offsetX + i * itemWidth + (itemWidth - barWidth) / 2;

    // Per-bar boxes — the cached rect layer below and the hover highlight both draw from these.
    // With a comparison, the CURRENT bar takes the right half of the band.
    const bars = values.map((val, i) => {
      const barHeight = (val / max) * usable;
      return {
        x: bandX(i) + (activeGhost ? subW + GROUP_GAP : 0),
        y: graphHeight - barHeight,
        w: subW,
        // Zero is a real absence, not a tiny bar. Keeping the old 2px minimum for positive values
        // preserves visibility of small counts without drawing a false dotted baseline on sparse
        // daily series such as mentions.
        h: val === 0 ? 0 : Math.max(barHeight, 2),
      };
    });
    const ghostBars = activeGhost
      ? activeGhost.map((v, i) => {
          const h = (v / max) * usable;
          return { x: bandX(i), y: graphHeight - h, w: subW, h: v === 0 ? 0 : Math.max(h, 2) };
        })
      : [];

    // Under the bars: gridlines + tick labels (expanded only).
    const underLayer = (
      <>
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

    // The bars themselves — flat single-token fill; the render site wraps this cached layer in a
    // group whose opacity carries the hover dim (0.85 idle → 0.55 while a column is hovered).
    // Ghost-пара рисуется в том же слое (контекст тускнеет вместе с остальными колонками).
    const barsLayer = (
      <>
        {ghostBars.map((b, i) => (
          <rect key={`gb${i}`} x={b.x} y={b.y} width={b.w} height={b.h} fill="hsl(var(--chart-role-comparison) / 0.35)" rx={2} />
        ))}
        {bars.map((b, i) => (
          <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill="hsl(var(--chart-role-primary))" rx={2} />
        ))}
      </>
    );

    // Above the bars: value/x labels (never dimmed — parity with the old per-rect opacity),
    // then the comparison overlay and the target line.
    const overLayer = (
      <>
        {values.map((val, i) => {
          const strideHit = labelIndexes.has(i);
          const showLabel = labels?.[i] && strideHit;
          const showValue = expanded && strideHit;
          if (!showLabel && !showValue) return null;
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
                // Крайние подписи прижимаются к краям плота (start/end), а не центрируются под
                // столбцом — центрированная последняя дата наполовину вылетала за svg и клипалась
                // («9 ин» вместо «9 июл.», дизайн-проход №3). Зеркало поведения LineChart.
                <text
                  x={i === values.length - 1 ? Math.min(bars[i].x + bars[i].w, width - 1) : i === 0 ? Math.max(bandX(i), 1) : barCenterX(i)}
                  y={chartHeight - 6}
                  textAnchor={i === values.length - 1 ? 'end' : i === 0 ? 'start' : 'middle'}
                  data-chart-axis-label="x"
                  className="pointer-events-none select-none fill-muted-foreground text-2xs font-medium tabular-nums"
                >
                  {labels?.[i]}
                </text>
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
                <line x1={gutterW} y1={barTop(v)} x2={chartWidth} y2={barTop(v)} stroke="hsl(var(--chart-role-neutral))" strokeDasharray="6 4" strokeWidth="1.2" opacity="0.7" />
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

    return { chartWidth, chartHeight, graphHeight, offsetX, itemWidth, bars, barTop, barCenterX, underLayer, barsLayer, overLayer };
  }, [values, labels, activeGhost, hasGhost, target, refLines, width, ctxHeight, height, expanded]);

  if (!values || values.length === 0 || !plot) {
    return <EmptyState compact title="Нет данных за период" className="flex h-40 items-center justify-center" />;
  }

  const { chartWidth, chartHeight, graphHeight, offsetX, itemWidth, bars, barTop, barCenterX } = plot;
  const n = values.length;

  const tipText = (i: number) => {
    const base = titles?.[i] ?? `${labels?.[i] ?? ''}: ${values[i]}`;
    return activeGhost && activeGhost[i] != null ? `${base} · пред. ${fmt.num(activeGhost[i])}` : base;
  };
  // Structured readout (label · Текущий · comparison · Δ) when a ghost series is present; else the
  // metric's own title text. Anchored to the hovered bar's top-centre.
  const buildTip = (i: number): TooltipState => {
    const x = barCenterX(i);
    const y = barTop(values[i]);
    if (activeGhost && activeGhost[i] != null) {
      const cur = values[i];
      const prev = activeGhost[i];
      const rows: TooltipRow[] = [
        { label: primaryLabel, value: formatValue(cur), color: 'hsl(var(--chart-role-primary))' },
        { label: ghostLabel, value: formatValue(prev), color: 'hsl(var(--chart-role-comparison))' },
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

  // ONE hit surface: the svg itself. The pointer x maps to its column in O(1); moving within a
  // column keeps the same state object, so those mousemoves don't re-render.
  const indexFromEvent = (e: ReactMouseEvent<SVGSVGElement>): number | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return null;
    const xView = ((e.clientX - rect.left) / rect.width) * chartWidth;
    return columnIndex(xView, n, offsetX, itemWidth);
  };
  const onSvgMove = (e: ReactMouseEvent<SVGSVGElement>) => {
    const i = indexFromEvent(e);
    if (i == null) return;
    setHover((prev) => (prev && prev.i === i ? prev : { i }));
  };
  // Drill only on a genuine click, not a scrub: a press that travelled >5px before release is a
  // drag-to-read gesture, not a tap. A click with no recorded press (keyboard / AT) passes through.
  const onSvgClick = onPointClick
    ? (e: ReactMouseEvent<SVGSVGElement>) => {
        const press = pressRef.current;
        pressRef.current = null;
        if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5) return;
        const i = indexFromEvent(e);
        if (i != null) {
          // The chart OWNS this click (point drill / pin) — keep it out of the host card's
          // whole-card expand.
          e.stopPropagation();
          onPointClick(i);
        }
      }
    : undefined;
  const clearHover = () => {
    pressRef.current = null;
    setHover(null);
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full"
      onMouseLeave={clearHover}
      onPointerLeave={clearHover}
    >
      <svg
        data-chart-kind="bar"
        data-chart-expanded={expanded ? '' : undefined}
        className={`block w-full ${onPointClick ? 'cursor-pointer' : 'cursor-crosshair'}`}
        height={chartHeight}
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        preserveAspectRatio="none"
        // Named graphic for AT (PieChart idiom) — see LineChart.tsx: series max, not the scale top.
        role="img"
        aria-label={`Столбчатая диаграмма: ${values.length} столбцов, макс ${fmt.short(Math.max(...values))}`}
        onMouseMove={onSvgMove}
        onMouseDown={onPointClick ? (e) => (pressRef.current = { x: e.clientX, y: e.clientY }) : undefined}
        onClick={onSvgClick}
      >
        {plot.underLayer}

        {/* Cached bar rects; hovering dims the whole group and the highlight below re-draws the
            hovered bar at full opacity — same reading as the old per-bar opacity swap, without
            re-rendering a rect per column per mousemove. transition-opacity only WHILE hovered so
            the un-dim on leave snaps (the full-opacity highlight unmounts in the same commit) — no
            below-idle dip on the just-hovered bar. */}
        <g className={hover ? 'transition-opacity' : undefined} opacity={hover ? 0.55 : 0.85}>
          {plot.barsLayer}
        </g>

        {/* Full-opacity highlight of the hovered bar — BETWEEN the dimmed bars and the ghost/target
            overlay, so the comparison + goal lines still paint OVER it (HEAD paint order). */}
        {hover && hover.i < n && (
          <rect x={bars[hover.i].x} y={bars[hover.i].y} width={bars[hover.i].w} height={bars[hover.i].h} fill="hsl(var(--chart-role-selection))" rx={2} className="pointer-events-none" />
        )}

        {plot.overLayer}

        {/* PINNED column — persistent highlight + dashed crosshair (under the live hover). */}
        {pinnedIndex != null && pinnedIndex < n && bars[pinnedIndex] && (
          <g className="pointer-events-none">
            <rect x={bars[pinnedIndex].x} y={bars[pinnedIndex].y} width={bars[pinnedIndex].w} height={bars[pinnedIndex].h} fill="hsl(var(--chart-role-selection))" rx={2} />
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
              className={`flex select-none items-center gap-1.5 rounded transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${ghostHidden ? 'opacity-40 line-through' : ''}`}
            >
              {/* Свотч-прямоугольник: сравнение теперь рисуется столбцами, не пунктиром. */}
              <span aria-hidden="true" className="h-2 w-3 rounded-sm" style={{ backgroundColor: 'hsl(var(--chart-role-comparison) / 0.35)' }} />
              {ghostLabel}
            </button>
          ) : (
            <span className="flex select-none items-center gap-1.5">
              <span aria-hidden="true" className="h-2 w-3 rounded-sm" style={{ backgroundColor: 'hsl(var(--chart-role-comparison) / 0.35)' }} />
              {ghostLabel}
            </span>
          )}
        </div>
      )}
      {/* Readout anchored to the hovered bar's top-center (not the cursor) */}
      <ChartTooltip tip={hover && hover.i < n ? buildTip(hover.i) : null} />
    </div>
  );
}
