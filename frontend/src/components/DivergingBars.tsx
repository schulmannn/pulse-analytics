import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { columnIndex } from '@/lib/chartHover';
import { axisLabelIndexSet } from '@/lib/chartLabels';
import { ChartTooltip } from '@/components/ChartTooltip';
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
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
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
    const maxAbs = Math.max(1, ...values.map((v) => Math.abs(v)));

    const W = Math.max(width, 1);
    const step = W / values.length;
    const barWidth = step * 0.7;
    const gap = step * 0.3;
    const labelIndexes = axisLabelIndexSet(values.length, W, { minLabelPx: expanded ? 68 : 78, maxLabels: expanded ? 12 : 7 });

    // Per-bar boxes — the cached rect layer below and the hover highlight both draw from these.
    const bars = values.map((v, i) => {
      const bh = Math.max(1, (Math.abs(v) / maxAbs) * (mid - 4));
      return {
        x: i * step + gap / 2,
        y: v >= 0 ? mid - bh : mid,
        w: barWidth,
        h: bh,
        fill: 'hsl(var(--chart-role-primary))',
        // Down bars: same ink, one luminance step quieter — position already says the direction.
        op: v >= 0 ? 1 : 0.6,
      };
    });

    const barsLayer = (
      <>
        {bars.map((b, i) => (
          <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill={b.fill} fillOpacity={b.op} rx={1} />
        ))}
      </>
    );

    const labelsLayer = hasLabels ? (
      <>
        {values.map((_, i) => {
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
        })}
      </>
    ) : null;

    return { W, h, mid, step, bars, barsLayer, labelsLayer, labelPad };
  }, [values, labels, width, ctxHeight, height, expanded]);

  if (!values || values.length === 0 || !plot) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        Нет данных
      </div>
    );
  }

  const { W, h, mid, step, bars, labelPad } = plot;
  const n = values.length;
  const tipText = (i: number) => titles?.[i] ?? `${values[i]}`;

  // ONE hit surface: the svg itself (the old per-bar rects carried a misleading pointer cursor —
  // there is no click action here, so the crosshair matches the other charts). Тултип ЯКОРИТСЯ
  // к вершине столбца, а не следует за курсором — канон всех остальных графиков (проход №3);
  // viewBox 1:1 с CSS-пикселями, поэтому координаты бара валидны и как контейнерные.
  const onSvgMove = (e: ReactMouseEvent<SVGSVGElement>) => {
    const svgRect = e.currentTarget.getBoundingClientRect();
    if (svgRect.width === 0) return;
    const xView = ((e.clientX - svgRect.left) / svgRect.width) * W;
    const i = columnIndex(xView, n, 0, step);
    setHover((prev) => (prev && prev.i === i ? prev : { i }));
  };

  return (
    <div ref={containerRef} className="relative w-full" onMouseLeave={() => setHover(null)}>
      <svg
        className="block w-full cursor-crosshair"
        height={h + labelPad}
        viewBox={`0 0 ${W} ${h + labelPad}`}
        preserveAspectRatio="none"
        onMouseMove={onSvgMove}
      >
        <line x1={0} y1={mid} x2={W} y2={mid} stroke="hsl(var(--border))" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />

        {/* Cached bar rects; hovering dims the whole group and the overlay below re-draws the
            hovered bar at full opacity — same reading as the old per-bar opacity swap.
            transition-opacity only WHILE hovered so the un-dim on leave snaps back to idle (the
            full-opacity highlight unmounts in the same commit) — no below-idle dip. */}
        <g className={hover ? 'transition-opacity' : undefined} opacity={hover ? 0.55 : 1}>
          {plot.barsLayer}
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
