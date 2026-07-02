import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  /** Bare value labels at the max point and the last point (no pills — Refined Technical). */
  markExtremes?: boolean;
  /** Hollow rings on every data point (steep-style reading aid for daily series). */
  showPoints?: boolean;
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
  markExtremes = false,
  showPoints = false,
}: LineChartProps) {
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
  // re-renders (setHover fires per crosshair move) don't re-run it. Before the early return
  // to keep the hook order stable.
  const anomalyIdx = useMemo(
    () => (markAnomalies && values && values.length >= 2 ? detectAnomalies(values) : []),
    [markAnomalies, values],
  );

  if (!values || values.length < 2) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        Нет данных за период
      </div>
    );
  }

  const h = height ?? 200;
  const W = Math.max(width, 1);
  const padR = 10;
  const padY = 12;

  const scaleVals = ghost && ghost.length ? [...values, ...ghost] : values;
  const computedMin = Math.min(...scaleVals);
  const computedMax = Math.max(...scaleVals);
  // The caller's yMin/yMax (e.g. a zero base for volume metrics) defines the domain; the nice
  // scale then only expands it outward to round tick values, never clips.
  const scale = niceScale(yMin ?? computedMin, yMax ?? computedMax);
  const min = scale.lo;
  const max = scale.hi;
  const range = max - min || 1;

  const yFor = (v: number) => h - padY - ((v - min) / range) * (h - 2 * padY);
  // Belt-and-braces dedupe: drop any tick whose formatted label repeats the previous one.
  const yAxis = scale.ticks
    .map((v) => ({ v, label: axisLabel(v, scale.step) }))
    .filter((tick, i, arr) => i === 0 || tick.label !== arr[i - 1].label);
  const yGridValues = yAxis.map((t) => t.v);
  const yGridPositions = yGridValues.map(yFor);
  const yLabels = yAxis.map((t) => t.label);
  // Left gutter reserved for the y labels (right-aligned inside it) so they never sit
  // on the line/area and the first label is never clipped by the container edge.
  const gutterW = Math.max(28, Math.round(Math.max(...yLabels.map((l) => l.length)) * CHAR_W) + 14);

  const n = values.length;
  const plotW = Math.max(W - gutterW - padR, 10);
  const step = plotW / Math.max(n - 1, 1);

  const points = values.map((v, i) => {
    const x = gutterW + i * step;
    const y = h - padY - ((v - min) / range) * (h - 2 * padY);
    return { x, y, v };
  });

  const firstPt = points[0];
  const lastPt = points[n - 1];

  const anomalySet = new Set(anomalyIdx);

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const areaPath = `${linePath} L ${lastPt.x} ${h - padY} L ${firstPt.x} ${h - padY} Z`;

  const ghostPath =
    ghost && ghost.length >= 2
      ? ghost
          .map((v, i) => {
            const gx = gutterW + i * step;
            const gy = h - padY - ((v - min) / range) * (h - 2 * padY);
            return `${i === 0 ? 'M' : 'L'} ${gx} ${gy}`;
          })
          .join(' ')
      : '';

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

  const tipText = (i: number) => {
    const base = titles?.[i] ?? fmt.num(values[i]);
    return anomalySet.has(i) ? `${base} · аномалия` : base;
  };
  const onEnter = (i: number) => () => {
    setHover((prev) => (prev && prev.i === i ? prev : { i }));
  };

  const hovered = hover && hover.i < n ? points[hover.i] : null;

  return (
    <div
      ref={containerRef}
      className="relative w-full"
      onMouseLeave={() => setHover(null)}
      onPointerLeave={() => setHover(null)}
    >
      <svg className="block w-full" height={h} viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--brand-iris))" stopOpacity="0.25" />
            <stop offset="100%" stopColor="hsl(var(--brand-iris))" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Gridlines — start after the label gutter */}
        {yGridPositions.map((yPos, idx) => (
          <line key={idx} x1={gutterW} y1={yPos} x2={W} y2={yPos} stroke="hsl(var(--border))" strokeDasharray="4 6" strokeWidth="1" opacity="0.6" vectorEffect="non-scaling-stroke" />
        ))}

        {/* Previous-period ghost line (faded dashed) — same y-scale for comparison */}
        {ghostPath && (
          <path d={ghostPath} fill="none" stroke="hsl(var(--muted-foreground))" strokeWidth="1.5" strokeDasharray="3 4" opacity="0.45" vectorEffect="non-scaling-stroke" />
        )}

        {/* Gradient area + line */}
        <path d={areaPath} fill={`url(#${gradientId})`} />
        <path d={linePath} fill="none" stroke="hsl(var(--brand-iris))" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />

        {/* Per-point hollow rings (steep-style) — knocked out from the paper so the line reads
            as a dotted sequence of measurements, not a continuous estimate */}
        {showPoints &&
          points.map((p, i) => (
            <circle key={`pt${i}`} cx={p.x} cy={p.y} r="3" fill="hsl(var(--background))" stroke="hsl(var(--brand-iris))" strokeWidth="1.5" vectorEffect="non-scaling-stroke" className="pointer-events-none" />
          ))}

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

        {/* Max / last value labels (markExtremes) — bare tabular text, no boxes */}
        {extremes.map((e) => (
          <text key={`e${e.key}`} x={e.x} y={e.y} textAnchor="middle" className="pointer-events-none select-none fill-ink2 text-2xs font-medium tabular-nums">
            {e.text}
          </text>
        ))}

        {/* Y-axis labels — right-aligned in the reserved gutter */}
        {yGridValues.map((_, idx) => (
          <text key={idx} x={gutterW - 8} y={yGridPositions[idx] + 3.5} textAnchor="end" className="pointer-events-none select-none fill-muted-foreground text-2xs font-medium tabular-nums">
            {yLabels[idx]}
          </text>
        ))}

        {/* Per-point hover targets (snap to nearest point) */}
        {points.map((p, i) => {
          const xStart = i === 0 ? 0 : p.x - step / 2;
          const xEnd = i === n - 1 ? W : p.x + step / 2;
          return (
            <rect key={i} x={xStart} y={0} width={Math.max(xEnd - xStart, 1)} height={h} fill="transparent" className="cursor-crosshair" onMouseMove={onEnter(i)} />
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

      {/* Readout anchored to the snapped data point (not the cursor) so it stays inside the chart */}
      <ChartTooltip tip={hovered ? { x: hovered.x, y: hovered.y, text: tipText(hover!.i) } : null} />
    </div>
  );
}
