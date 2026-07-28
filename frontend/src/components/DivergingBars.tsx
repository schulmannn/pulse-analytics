import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { columnIndex } from '@/lib/chartHover';
import { axisLabelIndexSet } from '@/lib/chartLabels';
import { seriesMotionKey } from '@/lib/chartMotion';
import { useMorphValues } from '@/lib/useMorphValues';
import { observeSize } from '@/lib/observeSize';
import { ChartTooltip } from '@/components/ChartTooltip';
import { EmptyState } from '@/components/EmptyState';
import { ChartExpandedContext, ExpandedChartHeightContext } from '@/components/ExpandableChart';

interface DivergingBarsProps {
  values: number[];
  /** Per-bar x-labels; thinned to a readable stride, like BarChart. */
  labels?: string[];
  titles?: string[];
  height?: number;
}

interface Hover {
  i: number;
}

/** Bars around a horizontal zero-line, MONOCHROME in the card's accent (steep): direction is
    encoded by position around zero, so both directions ride --chart-role-primary — the down bars
    a step quieter (opacity), never the semantic red/green (владелец: бары не кричат; на
    тинтованной карточке бары автоматически берут её пастель через accent-скоуп). Fills the
    height an ancestor dictates — the fixed widget tile or the expand overlay — via
    ExpandedChartHeightContext (like BarChart), else the caller's `height`, else 120px. */
export function DivergingBars({ values, labels, titles, height }: DivergingBarsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  // Measure the render width so the viewBox is 1:1 with CSS pixels — a fixed 600-wide viewBox
  // scaled to fit stretched the zero-line + labels at inconsistent sizes.
  const [width, setWidth] = useState(600);
  // The fixed tile / overlay dictates the height; inline renders fall back to `height`.
  const ctxHeight = useContext(ExpandedChartHeightContext);
  const expanded = useContext(ChartExpandedContext);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth || 600);
    measure();
    return observeSize(el, measure);
  }, []);

  // The readout must not linger once the chart scrolls away or the window loses focus —
  // mouseleave alone does not fire during wheel scrolling (канон BarChart/PieChart, проход №3).
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

  // ── Geometry + the static plot, memoized APART from hover ────────────────────────────────
  // The tooltip follows the cursor here (a per-mousemove setState) — the cached layers keep
  // that from re-creating a rect per bar per move, and the per-bar transparent hit-rects are
  // replaced by ONE mouse handler on the svg with O(1) column math (columnIndex).
  const plot = useMemo(() => {
    if (!values || values.length === 0) return null;

    const hasLabels = !!labels && labels.length > 0;
    const labelPad = hasLabels ? 20 : 0;
    // The dictated height covers the whole element; reserve the label band inside it so the bars
    // area (mid line ± bars) never grows past the tile.
    const total = ctxHeight ?? height ?? 120;
    const h = Math.max(total - labelPad, 1);
    const mid = h / 2;
    const normalized = values.map((value) => (Number.isFinite(value) ? value : 0));
    const maxAbs = Math.max(1, ...normalized.map((value) => Math.abs(value)));

    const W = Math.max(width, 1);
    const step = W / values.length;
    const barWidth = step * 0.7;
    const gap = step * 0.3;
    const labelIndexes = axisLabelIndexSet(values.length, W, { minLabelPx: expanded ? 68 : 78, maxLabels: expanded ? 12 : 7 });

    // SIGNED extents (px up/down from the midline) — the one dimension the data owns; the morph
    // below tweens these, and the boxes/opacity derive from the tweened sign+magnitude per frame.
    // Invalid values are honest zeros (op 0 keeps them invisible even mid-flight).
    const extents = normalized.map((value, i) => {
      const valid = Number.isFinite(values[i]);
      const bh = valid ? Math.max(1, (Math.abs(value) / maxAbs) * (mid - 4)) : 0;
      return value >= 0 ? bh : -bh;
    });
    const valid = values.map((value) => Number.isFinite(value));

    const labelsLayer = hasLabels
      ? values.map((_, i) => {
          const show = labels?.[i] && labelIndexes.has(i);
          if (!show) return null;
          return (
            <text
              key={`l${i}`}
              x={i * step + step / 2}
              y={h + 14}
              textAnchor="middle"
              data-chart-axis-label="x"
              className="pointer-events-none select-none fill-muted-foreground text-2xs font-medium tabular-nums"
            >
              {labels?.[i]}
            </text>
          );
        })
      : null;

    return { W, h, mid, step, barWidth, gap, extents, valid, labelsLayer, labelPad };
  }, [values, labels, width, ctxHeight, height, expanded]);

  // ── UPDATE morph (canon BarChart): the signed silhouette flows into the new shape ─────────
  // A sign flip mid-flight honestly passes through the midline (the bar shrinks to 0 and re-grows
  // on the other side), switching to the quieter down-opacity at the crossing.
  const motionKey = seriesMotionKey(values);
  const targetExtents = useMemo(() => plot?.extents ?? [], [plot]);
  const extents = useMorphValues(targetExtents, motionKey, 'silhouette');
  const bars = useMemo(() => {
    if (!plot) return null;
    return extents.map((extent, i) => {
      const bh = Math.abs(extent);
      return {
        x: i * plot.step + plot.gap / 2,
        y: extent >= 0 ? plot.mid - bh : plot.mid,
        w: plot.barWidth,
        h: bh,
        fill: 'hsl(var(--chart-role-primary))',
        // Down bars: same ink, one luminance step quieter — position already says the direction.
        op: plot.valid[i] ? (extent >= 0 ? 1 : 0.6) : 0,
      };
    });
  }, [plot, extents]);
  const barsLayer = useMemo(
    () =>
      bars?.map((b, i) => (
        <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill={b.fill} fillOpacity={b.op} rx={1} />
      )) ?? null,
    [bars],
  );

  // Pointer reading is supplementary to the graphic's full text summary. Listen on the passive
  // SVG node and keep it out of the keyboard order; there is no activation action to expose.
  useEffect(() => {
    const svg = svgRef.current;
    const container = containerRef.current;
    if (!svg || !container || !plot || values.length === 0) return;
    const handleMove = (event: globalThis.MouseEvent) => {
      const svgRect = svg.getBoundingClientRect();
      if (svgRect.width === 0) return;
      const xView = ((event.clientX - svgRect.left) / svgRect.width) * plot.W;
      const i = columnIndex(xView, values.length, 0, plot.step);
      setHover((prev) => (prev && prev.i === i ? prev : { i }));
    };
    const clearHover = () => setHover(null);
    svg.addEventListener('mousemove', handleMove);
    container.addEventListener('mouseleave', clearHover);
    return () => {
      svg.removeEventListener('mousemove', handleMove);
      container.removeEventListener('mouseleave', clearHover);
    };
  }, [plot, values.length]);

  const hasFiniteValue = values?.some((value) => Number.isFinite(value)) ?? false;
  if (!values || values.length === 0 || !hasFiniteValue || !plot || !bars) {
    return <EmptyState compact size="chart" title="Нет данных" />;
  }

  const { W, h, mid, labelPad } = plot;
  const n = values.length;
  const tipText = (i: number) =>
    titles?.[i] ?? (Number.isFinite(values[i]) ? `${values[i]}` : 'Нет данных');
  const finiteValues = values.filter(Number.isFinite);
  const minimum = finiteValues.length > 0 ? Math.min(...finiteValues) : null;
  const maximum = finiteValues.length > 0 ? Math.max(...finiteValues) : null;
  const latestIndex = values.length - 1;
  const latestName = labels?.[latestIndex] ?? `точка ${values.length}`;
  const latestDetail = titles?.[latestIndex];
  const latestValue = Number.isFinite(values[latestIndex]) ? `${values[latestIndex]}` : 'нет данных';
  const accessibleSummary = [
    `Дельта по ${n} точкам.`,
    minimum == null ? 'Числовых значений нет.' : `Минимум ${minimum}; максимум ${maximum}.`,
    `Последняя — ${latestName}: ${latestValue}${latestDetail ? ` (${latestDetail})` : ''}.`,
  ].join(' ');

  return (
    <div ref={containerRef} className="relative w-full">
      <svg
        ref={svgRef}
        role="img"
        aria-label={accessibleSummary}
        className="block w-full cursor-crosshair"
        height={h + labelPad}
        viewBox={`0 0 ${W} ${h + labelPad}`}
        preserveAspectRatio="none"
      >
        {/* БЕЗ svg <title> — см. LineChart/BarChart: aria-label уже именует график, а <title>
            дублировал его нестилизуемым нативным тултипом с острыми углами поверх ChartTooltip. */}
        <line x1={0} y1={mid} x2={W} y2={mid} stroke="hsl(var(--border))" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />

        {/* Bar rects (morphed above); hovering dims the whole group and the overlay below re-draws
            the hovered bar at full opacity — same reading as the old per-bar opacity swap.
            transition-opacity only WHILE hovered so the un-dim on leave snaps back to idle (the
            full-opacity highlight unmounts in the same commit) — no below-idle dip. */}
        <g className={hover ? 'transition-opacity' : undefined} opacity={hover ? 0.55 : 1}>
          {barsLayer}
        </g>

        {plot.labelsLayer}

        {hover && hover.i < n && (
          <rect
            x={bars[hover.i].x}
            y={bars[hover.i].y}
            width={bars[hover.i].w}
            height={bars[hover.i].h}
            fill={bars[hover.i].fill}
            fillOpacity={bars[hover.i].op}
            rx={1}
            className="pointer-events-none"
          />
        )}
      </svg>
      <ChartTooltip
        tip={
          hover && hover.i < n
            ? { x: bars[hover.i].x + bars[hover.i].w / 2, y: bars[hover.i].y, text: tipText(hover.i) }
            : null
        }
      />
    </div>
  );
}
