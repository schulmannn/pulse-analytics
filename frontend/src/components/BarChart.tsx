import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { fmt } from '@/lib/format';
import { columnIndex } from '@/lib/chartHover';
import { axisLabelIndexSet } from '@/lib/chartLabels';
import { ChartTooltip, type TooltipRow, type TooltipState } from '@/components/ChartTooltip';
import { axisLabel, niceScale } from '@/components/LineChart';
import { ChartExpandedContext, ExpandedChartHeightContext, WidgetTargetContext } from '@/components/ExpandableChart';

interface BarChartProps {
  values: number[];
  labels?: string[];
  titles?: string[];
  height?: number;
  /** Comparison series (previous period / baseline), drawn as a dashed --chart-2 overlay
      line across the bar tops, with a legend row — the visual delta for bar charts. */
  ghost?: number[];
  /** Legend name for the ghost series (default «Прошлый период»). */
  ghostLabel?: string;
  /** When set, bars become clickable (a drilldown gesture): a click anywhere on the chart fires
      this with the hovered column index and shows a pointer cursor. Hover behaviour is unchanged. */
  onPointClick?: (index: number) => void;
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

function finiteChartValue(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function BarChart({ values, labels, titles, height = 200, ghost, ghostLabel = 'Прошлый период', onPointClick, legendToggle = true }: BarChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Press position (client px) for the drag guard: the svg-level onClick would otherwise drill on
  // a press-drag-release scrub (the browser retargets a cross-child click to the svg). null = no
  // press recorded, so a keyboard/AT-synthesized click still passes through.
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  // The comparison overlay can be toggled off via its legend chip (steep #9) — hidden, it also
  // drops out of the bar y-domain so the bars rescale to the current series.
  const [ghostHidden, setGhostHidden] = useState(false);
  const safeValues = useMemo(() => values.map(finiteChartValue), [values]);
  const safeGhost = useMemo(() => ghost?.map(finiteChartValue), [ghost]);
  // A freshly-enabled or changed comparison always starts SHOWN: reset the manual hide when the
  // ghost's content changes, keyed on a content signature (not identity) so a referentially-
  // unstable-but-equal re-render never resets it (which would make the chip un-clickable).
  const ghostKey = safeGhost && safeGhost.length >= 2 ? safeGhost.join(',') : '';
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

  const hasGhost = !!safeGhost && safeGhost.length === safeValues.length && safeGhost.length >= 2;
  // Toggled off, the comparison drops out of every draw/measure below; the legend chip stays
  // visible so it can be toggled back on. Derived before the plot memo (its inputs).
  const showGhost = hasGhost && !ghostHidden;
  const activeGhost = showGhost ? safeGhost : undefined;

  // ── Geometry + the static plot, memoized APART from hover ────────────────────────────────
  // Hover used to swap every bar's opacity and re-create the whole element tree per mousemove
  // (plus a transparent hit-rect per column). Now the bars render ONCE into a cached layer; the
  // hover dim is a single group-opacity attribute, the hovered bar is re-drawn at full opacity
  // in the overlay below, and the svg carries ONE mouse handler with O(1) column math.
  const plot = useMemo(() => {
    if (safeValues.length === 0) return null;

    // Expanded view: bars scale against a NICE domain top (1/2/5×10ⁿ) so the y ticks land on
    // round values, like LineChart — the old max/mid pair printed «262» next to «2.5k».
    // The domain also covers the target and the (shown) comparison line — both must stay visible.
    const rawMax = Math.max(...safeValues, 1, target ?? 0, ...(activeGhost ?? []));
    const scale = expanded ? niceScale(0, rawMax) : null;
    const max = scale ? scale.hi : rawMax;
    const n = safeValues.length;
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
    // Comparison overlay: a dashed line across the previous-period value at each bar centre.
    const ghostPath = activeGhost
      ? activeGhost.map((v, i) => `${i === 0 ? 'M' : 'L'} ${barCenterX(i)} ${barTop(v)}`).join(' ')
      : '';

    // Per-bar boxes — the cached rect layer below and the hover highlight both draw from these.
    const bars = safeValues.map((val, i) => {
      const barHeight = (val / max) * usable;
      return {
        x: offsetX + i * itemWidth + (itemWidth - barWidth) / 2,
        y: graphHeight - barHeight,
        w: barWidth,
        h: Math.max(barHeight, 2),
      };
    });

    // Under the bars: gridlines + tick labels (expanded only).
    const underLayer = (
      <>
        {yTicks.map((v, idx) => {
          const y = barTop(v);
          return (
            <g key={`t${idx}`}>
              <line x1={gutterW} y1={y} x2={chartWidth} y2={y} stroke="hsl(var(--border))" strokeDasharray="4 6" strokeWidth="1" opacity="0.6" />
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
    const barsLayer = (
      <>
        {bars.map((b, i) => (
          <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill="hsl(var(--brand-iris))" rx={2} />
        ))}
      </>
    );

    // Above the bars: value/x labels (never dimmed — parity with the old per-rect opacity),
    // then the comparison overlay and the target line.
    const overLayer = (
      <>
        {safeValues.map((val, i) => {
          const strideHit = labelIndexes.has(i);
          const showLabel = labels?.[i] && strideHit;
          const showValue = expanded && strideHit;
          if (!showLabel && !showValue) return null;
          return (
            <g key={`l${i}`}>
              {showValue && (
                <text
                  x={bars[i].x + barWidth / 2}
                  y={bars[i].y - 4}
                  textAnchor="middle"
                  className="pointer-events-none select-none fill-ink2 text-2xs font-medium tabular-nums"
                >
                  {fmt.short(val)}
                </text>
              )}
              {showLabel && (
                <text
                  x={bars[i].x + barWidth / 2}
                  y={chartHeight - 6}
                  textAnchor="middle"
                  data-chart-axis-label="x"
                  className="pointer-events-none select-none fill-muted-foreground text-2xs font-medium"
                >
                  {labels?.[i]}
                </text>
              )}
            </g>
          );
        })}

        {/* Comparison overlay — dashed --chart-2 line across the previous-period values, plus
            hollow dots at each point so the delta reads at a glance (steep). */}
        {activeGhost && (
          <g className="pointer-events-none">
            <path d={ghostPath} fill="none" stroke="hsl(var(--chart-2))" strokeWidth="1.8" strokeDasharray="5 4" opacity="0.9" />
            {activeGhost.map((v, i) => (
              <circle key={`g${i}`} cx={barCenterX(i)} cy={barTop(v)} r="2.5" fill="hsl(var(--card))" stroke="hsl(var(--chart-2))" strokeWidth="1.5" />
            ))}
          </g>
        )}

        {/* Target level (widget pref) — dashed goal line + right-aligned label, above the bars */}
        {target != null && (
          <>
            <line x1={gutterW} y1={barTop(target)} x2={chartWidth} y2={barTop(target)} stroke="hsl(var(--muted-foreground))" strokeDasharray="6 4" strokeWidth="1.2" opacity="0.8" className="pointer-events-none" />
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
      </>
    );

    return { chartWidth, chartHeight, graphHeight, offsetX, itemWidth, bars, barTop, barCenterX, underLayer, barsLayer, overLayer };
  }, [safeValues, labels, activeGhost, hasGhost, target, width, ctxHeight, height, expanded]);

  if (safeValues.length === 0 || !plot) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        Нет данных
      </div>
    );
  }

  const { chartWidth, chartHeight, graphHeight, offsetX, itemWidth, bars, barTop, barCenterX } = plot;
  const n = safeValues.length;

  const tipText = (i: number) => {
    const base = titles?.[i] ?? `${labels?.[i] ?? ''}: ${safeValues[i]}`;
    return activeGhost && activeGhost[i] != null ? `${base} · пред. ${fmt.short(activeGhost[i])}` : base;
  };
  // Structured readout (label · Текущий · comparison · Δ) when a ghost series is present; else the
  // metric's own title text. Anchored to the hovered bar's top-centre.
  const buildTip = (i: number): TooltipState => {
    const x = barCenterX(i);
    const y = barTop(safeValues[i]);
    if (activeGhost && activeGhost[i] != null) {
      const cur = safeValues[i];
      const prev = activeGhost[i];
      const rows: TooltipRow[] = [
        { label: 'Текущий', value: fmt.short(cur), color: 'hsl(var(--brand-iris))' },
        { label: ghostLabel, value: fmt.short(prev), color: 'hsl(var(--chart-2))' },
      ];
      const d = prev !== 0 ? ((cur - prev) / Math.abs(prev)) * 100 : null;
      if (d != null && Number.isFinite(d)) rows.push({ label: 'Δ', value: `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}%` });
      return { x, y, title: labels?.[i], rows };
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
        if (i != null) onPointClick(i);
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
        className={`block w-full ${onPointClick ? 'cursor-pointer' : 'cursor-crosshair'}`}
        height={chartHeight}
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        preserveAspectRatio="none"
        // Named graphic for AT (PieChart idiom) — see LineChart.tsx: series max, not the scale top.
        role="img"
        aria-label={`Столбчатая диаграмма: ${safeValues.length} столбцов, макс ${fmt.short(Math.max(...safeValues))}`}
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
          <rect x={bars[hover.i].x} y={bars[hover.i].y} width={bars[hover.i].w} height={bars[hover.i].h} fill="hsl(var(--brand-iris))" rx={2} className="pointer-events-none" />
        )}

        {plot.overLayer}

        {/* Hovered-column crosshair + the comparison point on it, painted over everything (parity
            with LineChart / HEAD). */}
        {hover && hover.i < n && (
          <g className="pointer-events-none">
            <line x1={barCenterX(hover.i)} y1={0} x2={barCenterX(hover.i)} y2={graphHeight} stroke="hsl(var(--brand-iris))" strokeWidth="1" opacity="0.3" vectorEffect="non-scaling-stroke" />
            {activeGhost && activeGhost[hover.i] != null && (
              <circle cx={barCenterX(hover.i)} cy={barTop(activeGhost[hover.i])} r="3.5" fill="hsl(var(--card))" stroke="hsl(var(--chart-2))" strokeWidth="1.5" />
            )}
          </g>
        )}
      </svg>
      {/* Comparison legend — names both series whenever a ghost is present; the comparison chip is a
          toggle (steep #9): click to hide/show the overlay. Where a page-level compare control already
          owns the on/off (legendToggle=false, the metric page) the chip is a static label instead. */}
      {hasGhost && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-2xs font-medium text-muted-foreground">
          <span className="flex select-none items-center gap-1.5">
            <span aria-hidden="true" className="h-2 w-3 rounded-sm" style={{ backgroundColor: 'hsl(var(--brand-iris))' }} />
            Текущий период
          </span>
          {legendToggle ? (
            <button
              type="button"
              aria-pressed={!ghostHidden}
              onClick={() => setGhostHidden((v) => !v)}
              title={ghostHidden ? 'Показать сравнение' : 'Скрыть сравнение'}
              className={`flex select-none items-center gap-1.5 rounded transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${ghostHidden ? 'opacity-40 line-through' : ''}`}
            >
              <span aria-hidden="true" className="w-4 border-t-2 border-dashed" style={{ borderColor: 'hsl(var(--chart-2))' }} />
              {ghostLabel}
            </button>
          ) : (
            <span className="flex select-none items-center gap-1.5">
              <span aria-hidden="true" className="w-4 border-t-2 border-dashed" style={{ borderColor: 'hsl(var(--chart-2))' }} />
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
