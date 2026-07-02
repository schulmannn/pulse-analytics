import { useContext, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { ChartTooltip } from '@/components/ChartTooltip';
import { ExpandedChartHeightContext } from '@/components/ExpandableChart';

interface DivergingBarsProps {
  values: number[];
  /** Per-bar x-labels; thinned to a readable stride, like BarChart. */
  labels?: string[];
  titles?: string[];
  height?: number;
}

interface Hover {
  i: number;
  x: number;
  y: number;
}

/** Bars around a horizontal zero-line (positive up = iris, negative down = ember). Fills the
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
  const labelStride = Math.max(1, Math.ceil(values.length / 10));

  const tipText = (i: number) => titles?.[i] ?? `${values[i]}`;
  const onMove = (i: number) => (event: ReactMouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHover({ i, x: event.clientX - rect.left, y: event.clientY - rect.top });
  };

  return (
    <div ref={containerRef} className="relative w-full" onMouseLeave={() => setHover(null)}>
      <svg className="block w-full" height={h + labelPad} viewBox={`0 0 ${W} ${h + labelPad}`} preserveAspectRatio="none">
        <line x1={0} y1={mid} x2={W} y2={mid} stroke="hsl(var(--border))" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        {values.map((v, i) => {
          const bh = Math.max(1, (Math.abs(v) / maxAbs) * (mid - 4));
          const x = i * step + gap / 2;
          const y = v >= 0 ? mid - bh : mid;
          const fill = v >= 0 ? 'hsl(var(--brand-iris))' : 'hsl(var(--brand-ember))';
          const showLabel =
            hasLabels && labels?.[i] && (i === 0 || i === values.length - 1 || i % labelStride === 0);
          return (
            <g key={i}>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={bh}
                fill={fill}
                rx={1}
                className="pointer-events-none transition-opacity"
                opacity={hover && hover.i !== i ? 0.55 : 1}
              />
              {showLabel && (
                <text
                  x={i * step + step / 2}
                  y={h + 14}
                  textAnchor="middle"
                  className="pointer-events-none select-none fill-muted-foreground text-2xs font-medium"
                >
                  {labels?.[i]}
                </text>
              )}
              <rect
                x={i * step}
                y={0}
                width={step}
                height={h}
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
