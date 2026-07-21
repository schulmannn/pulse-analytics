import { useId, useMemo, useState } from 'react';
import type { MouseEvent } from 'react';
import { seriesMotionKey } from '@/lib/chartMotion';
import type { MorphPoint } from '@/lib/chartMorph';
import { SparklineSeries } from '@/components/SparklineSeries';
import { cn } from '@/lib/utils';

interface SparklineProps {
  values: number[];
  /** Per-point labels (e.g. dates), same length as values — used in the hover read-out. */
  labels?: string[];
  /** Full hsl() stroke/fill colour, e.g. 'hsl(var(--brand-iris))'. */
  color?: string;
  /** Add a soft gradient area fill under the line (featured cards). */
  area?: boolean;
  strokeWidth?: number;
  className?: string;
  /** Show peak + current markers and a hover dot/guide. */
  interactive?: boolean;
  /**
   * Idle text shown under the line (e.g. "по дням"). On hover it is replaced by the read-out
   * (date · value · day-over-day Δ). Omit it to suppress the read-out line entirely (compact
   * tiles) — hover then only moves the dot, so there's no layout shift.
   */
  caption?: string;
  /** Formats a value for the hover read-out (default: String). */
  formatValue?: (n: number) => string;
}

// Same viewBox the path math in format.ts uses; markers are positioned as %s of it so they stay
// glued to the line under preserveAspectRatio="none" (both axes stretch with the container).
const PAD = 2;
const VBW = 200;
const VBH = 32;

/**
 * Target geometry in viewBox coordinates — the SAME px/py mapping {@link sparkPath} uses (min/max
 * normalisation, PAD inset), so a settled morph frame is byte-identical to the static render. The
 * viewBox is fixed (200×32); geometry depends only on the values, never on container size, so a
 * resize can't change these points and never restarts the morph.
 */
function computeSparkPoints(values: number[]): MorphPoint[] {
  const n = values.length;
  if (n === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = (VBW - PAD * 2) / Math.max(n - 1, 1);
  return values.map((v, i) => ({
    x: PAD + i * step,
    y: VBH - PAD - ((v - min) / range) * (VBH - PAD * 2),
  }));
}

/**
 * Tiny inline trend line. `area` adds a gradient fill that fades to transparent (featured
 * KPIs); compact tiles use just the stroke. When `interactive`, it gains a peak marker, a
 * current-value dot, and a hover dot + guide that (with `caption`) surfaces the date/value/Δ
 * read-out. Renders nothing for <2 points (skeleton/empty stays clean).
 */
export function Sparkline({
  values,
  labels,
  color = 'hsl(var(--brand-iris))',
  area = false,
  strokeWidth = 1.6,
  className,
  interactive = false,
  caption,
  formatValue = String,
}: SparklineProps) {
  // Strip colons from useId — they're valid in ids but break SVG url(#…) refs in some browsers.
  const gradientId = `sl${useId().replace(/:/g, '')}`;
  const [hover, setHover] = useState<number | null>(null);
  // Target morph geometry, memoised on the VALUES reference: a hover rerender keeps the same `values`
  // ref (hover is local state — the parent doesn't re-render), so the morph layer sees a stable
  // `points` and never restarts; a period/filter swap hands down a new array → new geometry → morph.
  const points = useMemo(() => computeSparkPoints(values ?? []), [values]);
  if (!values || values.length < 2) return null;

  // Stable DATA signature (see index.css «Chart motion») — a change (period / filter swap, longer /
  // shorter window) tells the morph layer to flow from the old shape into the new one; hover (separate
  // state), a container resize (viewBox geometry is size-independent) and a value-identical refetch all
  // yield the SAME key, so none of them restart the morph.
  const motionKey = seriesMotionKey(values);

  const n = values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = (VBW - PAD * 2) / Math.max(n - 1, 1);
  const xPct = (i: number) => ((PAD + i * step) / VBW) * 100;
  const yPct = (v: number) => ((VBH - PAD - ((v - min) / range) * (VBH - PAD * 2)) / VBH) * 100;

  const maxIdx = values.indexOf(max);
  const lastIdx = n - 1;
  const active = hover;

  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const ratio = (e.clientX - rect.left) / rect.width;
    setHover(Math.max(0, Math.min(n - 1, Math.round(ratio * (n - 1)))));
  };

  // Read-out text: idle caption, or date · value · Δ-vs-previous-point while hovering.
  let readout = caption ?? '';
  if (active != null) {
    const v = values[active];
    const label = labels?.[active];
    const prev = active > 0 ? values[active - 1] : null;
    const diff = prev != null ? v - prev : null;
    const diffStr =
      diff != null && diff !== 0 ? ` ${diff > 0 ? '↑' : '↓'}${formatValue(Math.abs(diff))}` : '';
    readout = `${label ? `${label} · ` : ''}${formatValue(v)}${diffStr}`;
  }

  const dot = (i: number, kind: 'peak' | 'last' | 'active') => (
    <span
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full',
        kind === 'active'
          ? 'h-2.5 w-2.5 ring-2 ring-background'
          : kind === 'peak'
            ? 'h-1.5 w-1.5 ring-2 ring-background'
            : 'h-1.5 w-1.5',
      )}
      style={{
        left: `${xPct(i)}%`,
        top: `${yPct(values[i])}%`,
        background: kind === 'peak' ? 'transparent' : color,
        boxShadow: kind === 'peak' ? `inset 0 0 0 1.5px ${color}` : undefined,
      }}
    />
  );

  return (
    // Flex column so the chart fills the height that's LEFT after the caption — otherwise the chart
    // took the full height (h-full) and the caption overflowed below the box onto whatever followed.
    <div className={cn('flex flex-col', className)}>
      <div
        className="relative min-h-0 w-full flex-1"
        onMouseMove={interactive ? onMove : undefined}
        onMouseLeave={interactive ? () => setHover(null) : undefined}
      >
        <svg
          viewBox={`0 0 ${VBW} ${VBH}`}
          preserveAspectRatio="none"
          className="h-full w-full"
          aria-hidden="true"
          data-chart-kind="sparkline"
        >
          {area && (
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.32" />
                <stop offset="100%" stopColor={color} stopOpacity="0" />
              </linearGradient>
            </defs>
          )}
          {/* The line/area MORPH from the previous shape into the new one on a data change (same as the
              full LineChart) instead of remounting + fading — one stable node whose point geometry
              interpolates. The mount-only reveal fade lives on data-chart-motion="morph" in index.css. */}
          <SparklineSeries
            points={points}
            signature={motionKey}
            color={color}
            strokeWidth={strokeWidth}
            area={area}
            gradientId={gradientId}
          />
        </svg>

        {interactive && (
          <>
            {/* Vertical guide at the hovered point. */}
            {active != null && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 w-px bg-border"
                style={{ left: `${xPct(active)}%` }}
              />
            )}
            {maxIdx !== lastIdx && active !== maxIdx && dot(maxIdx, 'peak')}
            {active !== lastIdx && dot(lastIdx, 'last')}
            {active != null && dot(active, 'active')}
          </>
        )}
      </div>

      {interactive && caption !== undefined && (
        <div className="mt-1 truncate text-2xs tabular-nums text-muted-foreground">{readout}</div>
      )}
    </div>
  );
}
