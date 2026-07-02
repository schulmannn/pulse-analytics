import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { fmt } from '@/lib/format';
import { ChartTooltip } from '@/components/ChartTooltip';
import { ChartExpandedContext } from '@/components/ExpandableChart';

interface BarChartProps {
  values: number[];
  labels?: string[];
  titles?: string[];
  height?: number;
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

export function BarChart({ values, labels, titles, height = 200 }: BarChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  // Measure render width so the viewBox is 1:1 with CSS pixels — a fixed 600-wide viewBox
  // scaled to fit would render labels/bars at inconsistent, fuzzy sizes.
  const [width, setWidth] = useState(600);
  // Expanded (modal) rendering opts into value labels + y ticks.
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

  if (!values || values.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        Нет данных
      </div>
    );
  }

  const max = Math.max(...values, 1);
  const n = values.length;
  const chartWidth = Math.max(width, 1);
  const chartHeight = height;
  const paddingBottom = labels && labels.length > 0 ? 24 : 0;
  const graphHeight = chartHeight - paddingBottom;
  // Expanded view: headroom for the value labels above full-height bars.
  const padTop = expanded ? 18 : 0;
  const usable = Math.max(graphHeight - padTop, 1);

  // Expanded view: y tick labels (max / mid) right-aligned in a reserved left gutter.
  const yTicks = expanded ? [max, max / 2] : [];
  const tickLabels = yTicks.map((v) => fmt.short(v));
  const gutterW = expanded
    ? Math.max(28, Math.round(Math.max(...tickLabels.map((l) => l.length)) * CHAR_W) + 14)
    : 0;

  // Cap the column width and center the group when there are few bars.
  const plotW = Math.max(chartWidth - gutterW, 10);
  const itemWidth = Math.min(plotW / n, MAX_BAR_W / BAR_RATIO);
  const barWidth = itemWidth * BAR_RATIO;
  const offsetX = gutterW + (plotW - itemWidth * n) / 2;
  // Thin x-labels on narrow widths so dense series (e.g. 14 days) don't overlap.
  const labelStride = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(chartWidth / 56))));

  const barTop = (val: number) => graphHeight - (val / max) * usable;
  const tipText = (i: number) => titles?.[i] ?? `${labels?.[i] ?? ''}: ${values[i]}`;
  const onEnter = (i: number) => () => {
    setHover((prev) => (prev && prev.i === i ? prev : { i }));
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full"
      onMouseLeave={() => setHover(null)}
      onPointerLeave={() => setHover(null)}
    >
      <svg className="block w-full" height={chartHeight} viewBox={`0 0 ${chartWidth} ${chartHeight}`} preserveAspectRatio="none">
        {/* Expanded: y gridlines with tick labels in the gutter */}
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

        {values.map((val, i) => {
          const barHeight = (val / max) * usable;
          const x = offsetX + i * itemWidth + (itemWidth - barWidth) / 2;
          const y = graphHeight - barHeight;
          const strideHit = i === 0 || i === n - 1 || i % labelStride === 0;
          const showLabel = labels?.[i] && strideHit;
          const showValue = expanded && strideHit;

          return (
            <g key={i}>
              {/* Flat single-token fill; hovered bar reads slightly stronger */}
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(barHeight, 2)}
                fill="hsl(var(--brand-iris))"
                rx={2}
                className="pointer-events-none transition-opacity"
                opacity={hover ? (hover.i === i ? 1 : 0.55) : 0.85}
              />
              {showValue && (
                <text
                  x={x + barWidth / 2}
                  y={y - 4}
                  textAnchor="middle"
                  className="pointer-events-none select-none fill-ink2 text-2xs font-medium tabular-nums"
                >
                  {fmt.short(val)}
                </text>
              )}
              {showLabel && (
                <text
                  x={x + barWidth / 2}
                  y={chartHeight - 6}
                  textAnchor="middle"
                  className="pointer-events-none select-none fill-muted-foreground text-2xs font-medium"
                >
                  {labels?.[i]}
                </text>
              )}
              {/* Wide transparent hit-area: hover anywhere over the column */}
              <rect
                x={offsetX + i * itemWidth}
                y={0}
                width={itemWidth}
                height={graphHeight}
                fill="transparent"
                className="cursor-crosshair"
                onMouseMove={onEnter(i)}
              />
            </g>
          );
        })}
      </svg>
      {/* Readout anchored to the hovered bar's top-center (not the cursor) */}
      <ChartTooltip
        tip={
          hover && hover.i < n
            ? { x: offsetX + hover.i * itemWidth + itemWidth / 2, y: barTop(values[hover.i]), text: tipText(hover.i) }
            : null
        }
      />
    </div>
  );
}
