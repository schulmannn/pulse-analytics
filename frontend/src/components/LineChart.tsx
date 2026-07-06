import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { fmt } from '@/lib/format';
import { detectAnomalies } from '@/lib/anomaly';
import { nearestPointIndex } from '@/lib/chartHover';
import { axisLabelIndexes } from '@/lib/chartLabels';
import { ChartTooltip, type TooltipRow, type TooltipState } from '@/components/ChartTooltip';
import { ChartExpandedContext, ChartRefLinesContext, ExpandedChartHeightContext, WidgetTargetContext } from '@/components/ExpandableChart';

interface LineChartProps {
  values: number[];
  labels?: string[];
  titles?: string[];
  yMin?: number;
  yMax?: number;
  height?: number;
  /** Overlay hollow amber rings on statistically unusual points (local-outlier detection). */
  markAnomalies?: boolean;
  /** Comparison series (previous period / baseline), drawn dashed in the contrast colour
      (--chart-2) on the same y-scale, with a built-in legend row under the chart. */
  ghost?: number[];
  /** Legend name for the ghost series (default «Прошлый период»). */
  ghostLabel?: string;
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
  markExtremes = false,
  showPoints = false,
  fullAxes = false,
  onPointClick,
  legendToggle = true,
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

  // Anomaly detection is O(n·window) statistics — memoized on the series so hover-driven
  // re-renders don't re-run it. Before the early return to keep the hook order stable.
  const anomalyIdx = useMemo(
    () => (markAnomalies && values && values.length >= 2 ? detectAnomalies(values) : []),
    [markAnomalies, values],
  );

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
    if (!values || values.length < 2) return null;

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
    // be visible.
    const scaleVals = [...values, ...(activeGhost ?? []), ...(target != null ? [target] : [])];
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

    const points = values.map((v, i) => {
      const x = gutterW + i * step;
      return { x, y: yFor(v), v };
    });

    const firstPt = points[0];
    const lastPt = points[n - 1];

    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    const areaPath = `${linePath} L ${lastPt.x} ${h - padB} L ${firstPt.x} ${h - padB} Z`;

    const ghostPath =
      activeGhost && activeGhost.length >= 2
        ? activeGhost
            .map((v, i) => {
              const gx = gutterW + i * step;
              return `${i === 0 ? 'M' : 'L'} ${gx} ${yFor(v)}`;
            })
            .join(' ')
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
      let maxI = 0;
      for (let k = 1; k < n; k++) if (values[k] > values[maxI]) maxI = k;
      const idxs = maxI === n - 1 ? [n - 1] : [maxI, n - 1];
      return idxs.map((k) => {
        const p = points[k];
        const text = fmt.short(values[k]);
        const halfW = (text.length * CHAR_W) / 2;
        const x = Math.min(Math.max(p.x, gutterW + halfW), Math.max(W - padR - halfW, gutterW + halfW));
        const fitsAbove = p.y - 18 >= 0;
        const y = fitsAbove ? p.y - 8 : p.y + 16;
        return { key: k, x, y, text };
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

        {/* Gradient area + line */}
        <path d={areaPath} fill={`url(#${gradientId})`} />
        <path d={linePath} fill="none" stroke="hsl(var(--chart-role-primary))" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />

        {/* Per-point hollow rings (steep-style) — knocked out from the paper so the line reads
            as a dotted sequence of measurements, not a continuous estimate */}
        {showPoints &&
          points.map((p, i) => (
            <circle key={`pt${i}`} cx={p.x} cy={p.y} r="3" fill="hsl(var(--background))" stroke="hsl(var(--chart-role-primary))" strokeWidth="1.5" vectorEffect="non-scaling-stroke" className="pointer-events-none" />
          ))}

        {/* Anomaly markers — hollow amber rings on statistically unusual points */}
        {anomalyIdx.map((i) => (
          <circle key={`a${i}`} cx={points[i].x} cy={points[i].y} r="5" fill="none" stroke="hsl(var(--chart-role-warning))" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        ))}

        {/* Last-point marker — flat crisp dot knocked out from the paper surface (no glow halo) */}
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

    return { W, h, gutterW, step, points, yFor, hasXAxis, staticLayer };
  }, [values, labels, activeGhost, hasGhostLegend, target, refLines, yMin, yMax, width, ctxHeight, height, expanded, showAxes, markExtremes, showPoints, anomalyIdx, gradientId]);

  if (!values || values.length < 2 || !plot) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        Нет данных за период
      </div>
    );
  }

  const { W, h, gutterW, step, points, yFor, hasXAxis } = plot;
  const n = values.length;
  const anomalySet = new Set(anomalyIdx);

  const tipText = (i: number) => {
    let base = titles?.[i] ?? fmt.num(values[i]);
    // Hovering a compared chart reads both series at once (comparison shown).
    if (activeGhost && activeGhost[i] != null) base = `${base} · пред. ${fmt.short(activeGhost[i])}`;
    return anomalySet.has(i) ? `${base} · аномалия` : base;
  };
  // The hover readout: a STRUCTURED card (date · Текущий · comparison · Δ) whenever a ghost series
  // is present — so the tooltip is an instrument, not a caption. Without a comparison, keep the
  // metric's own rich title text (velocity/history carry extra context there).
  const buildTip = (i: number): TooltipState => {
    const p = points[i];
    if (activeGhost && activeGhost[i] != null) {
      const cur = values[i];
      const prev = activeGhost[i];
      const rows: TooltipRow[] = [
        { label: 'Текущий', value: fmt.short(cur), color: 'hsl(var(--chart-role-primary))' },
        { label: ghostLabel, value: fmt.short(prev), color: 'hsl(var(--chart-role-comparison))' },
      ];
      const d = prev !== 0 ? ((cur - prev) / Math.abs(prev)) * 100 : null;
      if (d != null && Number.isFinite(d)) rows.push({ label: 'Δ', value: `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}%` });
      const title = anomalySet.has(i) ? `${labels?.[i] ?? ''} · аномалия` : labels?.[i];
      return { x: p.x, y: p.y, title, rows };
    }
    return { x: p.x, y: p.y, text: tipText(i) };
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
        if (i != null) onPointClick(i);
      }
    : undefined;
  const clearHover = () => {
    pressRef.current = null;
    setHover(null);
  };

  const hovered = hover && hover.i < n ? points[hover.i] : null;
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
        className={`block w-full ${onPointClick ? 'cursor-pointer' : 'cursor-crosshair'}`}
        height={h}
        viewBox={`0 0 ${W} ${h}`}
        preserveAspectRatio="none"
        // A named graphic for AT (PieChart idiom): role="img" stops screen readers from announcing
        // the raw axis <text> ticks as loose numbers, and the label carries the data a mouse user
        // reads from hover (per-point keyboard access is a separate roadmap item). Math.max over
        // the SERIES — the in-scope `max` is the padded nice-scale top, not the data max.
        role="img"
        aria-label={`График: ${values.length} точек, макс ${fmt.short(Math.max(...values))}, последнее ${fmt.short(values[values.length - 1])}`}
        onMouseMove={onSvgMove}
        onMouseDown={onPointClick ? (e) => (pressRef.current = { x: e.clientX, y: e.clientY }) : undefined}
        onClick={onSvgClick}
      >
        {plot.staticLayer}

        {/* Hovered-point crosshair + marker (+ the comparison point at the same x, so hovering
            reads BOTH series) — the only elements a hover re-render touches. */}
        {hovered && (
          <>
            <line x1={hovered.x} y1={0} x2={hovered.x} y2={h} stroke="hsl(var(--chart-role-selection))" strokeWidth="1" opacity="0.35" vectorEffect="non-scaling-stroke" />
            {activeGhost && activeGhost[hover!.i] != null && (
              <circle cx={hovered.x} cy={yFor(activeGhost[hover!.i])} r="3.5" fill="hsl(var(--card))" stroke="hsl(var(--chart-role-comparison))" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            )}
            <circle cx={hovered.x} cy={hovered.y} r="4" fill="hsl(var(--chart-role-selection))" stroke="hsl(var(--background))" strokeWidth="1.5" />
          </>
        )}
      </svg>

      {/* Minimal x labels (axis-free cards): first / mid / last under the svg. Axes mode
          draws the real in-svg x-axis above instead. */}
      {labels && labels.length > 0 && !hasXAxis && (
        <div className="mt-1.5 flex select-none justify-between gap-2 px-1 text-2xs font-medium text-muted-foreground">
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
