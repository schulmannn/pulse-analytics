import { useId, useState } from 'react';
import type { MouseEvent } from 'react';
import { sparkAreaPath, sparkPath } from '@/lib/format';
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
  if (!values || values.length < 2) return null;

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
          ? 'h-2.5 w-2.5 ring-2 ring-card'
          : kind === 'peak'
            ? 'h-1.5 w-1.5 ring-2 ring-card'
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
    <div className={className}>
      <div
        className="relative h-full w-full"
        onMouseMove={interactive ? onMove : undefined}
        onMouseLeave={interactive ? () => setHover(null) : undefined}
      >
        <svg
          viewBox={`0 0 ${VBW} ${VBH}`}
          preserveAspectRatio="none"
          className="h-full w-full"
          aria-hidden="true"
        >
          {area && (
            <>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity="0.32" />
                  <stop offset="100%" stopColor={color} stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={sparkAreaPath(values)} fill={`url(#${gradientId})`} />
            </>
          )}
          <path
            d={sparkPath(values)}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
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
        <div className="mt-1 truncate text-[10px] tabular-nums text-muted-foreground">{readout}</div>
      )}
    </div>
  );
}
