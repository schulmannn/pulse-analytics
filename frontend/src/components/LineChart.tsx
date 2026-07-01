import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { fmt } from '@/lib/format';
import { detectAnomalies } from '@/lib/anomaly';
import { ChartTooltip } from '@/components/ChartTooltip';

interface LineChartProps {
  values: number[];
  labels?: string[];
  titles?: string[];
  yMin?: number;
  yMax?: number;
  height?: number;
  /** Overlay hollow amber rings on statistically unusual points (local-outlier detection). */
  markAnomalies?: boolean;
  /** A faded dashed previous-period series, drawn on the same y-scale for visual comparison. */
  ghost?: number[];
}

interface Hover {
  i: number;
  x: number;
  y: number;
}

export function LineChart({ values, labels, titles, yMin, yMax, height, markAnomalies, ghost }: LineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  // Measure the real render width so the viewBox is 1:1 with CSS pixels — otherwise a
  // fixed 600-wide viewBox stretched to a wide container magnifies text + markers 2-3×.
  const [width, setWidth] = useState(600);
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

  if (!values || values.length < 2) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        Нет данных за период
      </div>
    );
  }

  const h = height ?? 200;
  const W = Math.max(width, 1);
  const padX = 10;
  const padY = 12;

  const scaleVals = ghost && ghost.length ? [...values, ...ghost] : values;
  const computedMin = Math.min(...scaleVals);
  const computedMax = Math.max(...scaleVals);
  const min = yMin ?? computedMin;
  const max = yMax ?? computedMax;
  const range = max - min || 1;

  const n = values.length;
  const step = (W - 2 * padX) / Math.max(n - 1, 1);

  const points = values.map((v, i) => {
    const x = padX + i * step;
    const y = h - padY - ((v - min) / range) * (h - 2 * padY);
    return { x, y, v };
  });

  const firstPt = points[0];
  const lastPt = points[n - 1];

  const anomalyIdx = markAnomalies ? detectAnomalies(values) : [];
  const anomalySet = new Set(anomalyIdx);

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const areaPath = `${linePath} L ${lastPt.x} ${h - padY} L ${firstPt.x} ${h - padY} Z`;

  const ghostPath =
    ghost && ghost.length >= 2
      ? ghost
          .map((v, i) => {
            const gx = padX + i * step;
            const gy = h - padY - ((v - min) / range) * (h - 2 * padY);
            return `${i === 0 ? 'M' : 'L'} ${gx} ${gy}`;
          })
          .join(' ')
      : '';

  const yGridValues = [max, (max + min) / 2, min];
  const yGridPositions = [padY, h / 2, h - padY];

  const tipText = (i: number) => {
    const base = titles?.[i] ?? fmt.num(values[i]);
    return anomalySet.has(i) ? `${base} · аномалия` : base;
  };
  const onMove = (i: number) => (event: ReactMouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHover({ i, x: event.clientX - rect.left, y: event.clientY - rect.top });
  };

  const hovered = hover ? points[hover.i] : null;

  return (
    <div ref={containerRef} className="relative w-full" onMouseLeave={() => setHover(null)}>
      <svg className="block w-full" height={h} viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--brand-iris))" stopOpacity="0.25" />
            <stop offset="100%" stopColor="hsl(var(--brand-iris))" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Gridlines */}
        {yGridPositions.map((yPos, idx) => (
          <line key={idx} x1={0} y1={yPos} x2={W} y2={yPos} stroke="hsl(var(--border))" strokeDasharray="4 6" strokeWidth="1" opacity="0.6" vectorEffect="non-scaling-stroke" />
        ))}

        {/* Previous-period ghost line (faded dashed) — same y-scale for comparison */}
        {ghostPath && (
          <path d={ghostPath} fill="none" stroke="hsl(var(--muted-foreground))" strokeWidth="1.5" strokeDasharray="3 4" opacity="0.45" vectorEffect="non-scaling-stroke" />
        )}

        {/* Gradient area + line */}
        <path d={areaPath} fill={`url(#${gradientId})`} />
        <path d={linePath} fill="none" stroke="hsl(var(--brand-iris))" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />

        {/* Anomaly markers — hollow amber rings on statistically unusual points */}
        {anomalyIdx.map((i) => (
          <circle key={`a${i}`} cx={points[i].x} cy={points[i].y} r="5" fill="none" stroke="hsl(var(--status-warn))" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        ))}

        {/* Last-point marker — flat crisp dot knocked out from the paper surface (no glow halo) */}
        <circle cx={lastPt.x} cy={lastPt.y} r="4" fill="hsl(var(--brand-iris))" stroke="hsl(var(--background))" strokeWidth="2" vectorEffect="non-scaling-stroke" />

        {/* Hovered-point crosshair + marker */}
        {hovered && (
          <>
            <line x1={hovered.x} y1={0} x2={hovered.x} y2={h} stroke="hsl(var(--brand-iris))" strokeWidth="1" opacity="0.35" vectorEffect="non-scaling-stroke" />
            <circle cx={hovered.x} cy={hovered.y} r="4" fill="hsl(var(--brand-iris))" stroke="hsl(var(--background))" strokeWidth="1.5" />
          </>
        )}

        {/* Y-axis labels */}
        {yGridValues.map((yVal, idx) => (
          <text key={idx} x={padX + 4} y={yGridPositions[idx] + (idx === 0 ? 12 : idx === 2 ? -4 : 4)} className="pointer-events-none select-none fill-muted-foreground text-2xs font-medium">
            {fmt.short(yVal)}
          </text>
        ))}

        {/* Per-point hover targets */}
        {points.map((p, i) => {
          const xStart = i === 0 ? 0 : p.x - step / 2;
          const xEnd = i === n - 1 ? W : p.x + step / 2;
          return (
            <rect key={i} x={xStart} y={0} width={Math.max(xEnd - xStart, 1)} height={h} fill="transparent" className="cursor-pointer" onMouseMove={onMove(i)} />
          );
        })}
      </svg>

      {/* X-axis labels */}
      {labels && labels.length > 0 && (
        <div className="mt-1.5 flex select-none justify-between px-1 text-2xs font-medium text-muted-foreground">
          <span>{labels[0]}</span>
          <span>{labels[Math.floor(labels.length / 2)]}</span>
          <span>{labels[labels.length - 1]}</span>
        </div>
      )}

      <ChartTooltip tip={hover ? { x: hover.x, y: hover.y, text: tipText(hover.i) } : null} />
    </div>
  );
}
