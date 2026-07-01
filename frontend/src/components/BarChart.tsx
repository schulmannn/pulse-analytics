import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { ChartTooltip } from '@/components/ChartTooltip';

interface BarChartProps {
  values: number[];
  labels?: string[];
  titles?: string[];
  height?: number;
}

interface Hover {
  i: number;
  x: number;
  y: number;
}

export function BarChart({ values, labels, titles, height = 200 }: BarChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  // Measure render width so the viewBox is 1:1 with CSS pixels — a fixed 600-wide viewBox
  // scaled to fit would render labels/bars at inconsistent, fuzzy sizes.
  const [width, setWidth] = useState(600);
  // Strip colons from useId — valid in ids, but break SVG url(#…) refs in some browsers.
  const gradientId = `bc${useId().replace(/:/g, '')}`;

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

  if (!values || values.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        Нет данных
      </div>
    );
  }

  const max = Math.max(...values, 1);
  const chartWidth = Math.max(width, 1);
  const chartHeight = height;
  const paddingBottom = labels && labels.length > 0 ? 24 : 0;
  const graphHeight = chartHeight - paddingBottom;

  const itemWidth = chartWidth / values.length;
  const barWidth = itemWidth * 0.7;
  const barGap = itemWidth * 0.3;
  // Thin x-labels on narrow widths so dense series (e.g. 14 days) don't overlap.
  const labelStride = Math.max(1, Math.ceil(values.length / Math.max(2, Math.floor(chartWidth / 56))));

  const tipText = (i: number) => titles?.[i] ?? `${labels?.[i] ?? ''}: ${values[i]}`;
  const onMove = (i: number) => (event: ReactMouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHover({ i, x: event.clientX - rect.left, y: event.clientY - rect.top });
  };

  return (
    <div ref={containerRef} className="relative w-full" onMouseLeave={() => setHover(null)}>
      <svg className="block w-full" height={chartHeight} viewBox={`0 0 ${chartWidth} ${chartHeight}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--brand-iris))" stopOpacity="1" />
            <stop offset="100%" stopColor="hsl(var(--brand-iris))" stopOpacity="0.55" />
          </linearGradient>
        </defs>
        {values.map((val, i) => {
          const barHeight = (val / max) * graphHeight;
          const x = i * itemWidth + barGap / 2;
          const y = graphHeight - barHeight;
          const showLabel = labels?.[i] && (i === 0 || i === values.length - 1 || i % labelStride === 0);

          return (
            <g key={i}>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(barHeight, 2)}
                fill={`url(#${gradientId})`}
                rx={2}
                className="pointer-events-none transition-opacity"
                opacity={hover && hover.i !== i ? 0.55 : 1}
              />
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
                x={i * itemWidth}
                y={0}
                width={itemWidth}
                height={graphHeight}
                fill="transparent"
                className="cursor-pointer"
                onMouseMove={onMove(i)}
              />
            </g>
          );
        })}
      </svg>
      <ChartTooltip tip={hover ? { x: hover.x, y: hover.y, text: tipText(hover.i) } : null} />
    </div>
  );
}
