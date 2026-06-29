import { useId } from 'react';
import { sparkAreaPath, sparkPath } from '@/lib/format';

interface SparklineProps {
  values: number[];
  /** Full hsl() stroke/fill colour, e.g. 'hsl(var(--brand-iris))'. */
  color?: string;
  /** Add a soft gradient area fill under the line (featured cards). */
  area?: boolean;
  strokeWidth?: number;
  className?: string;
}

/**
 * Tiny inline trend line. `area` adds a gradient fill that fades to transparent (featured
 * KPIs); compact tiles use just the stroke. Decorative — the number + delta carry the
 * meaning, so it's aria-hidden. Renders nothing for <2 points (skeleton/empty stays clean).
 */
export function Sparkline({
  values,
  color = 'hsl(var(--brand-iris))',
  area = false,
  strokeWidth = 1.6,
  className,
}: SparklineProps) {
  // Strip colons from useId — they're valid in ids but break SVG url(#…) refs in some browsers.
  const gradientId = `sl${useId().replace(/:/g, '')}`;
  if (!values || values.length < 2) return null;

  return (
    <svg viewBox="0 0 200 32" preserveAspectRatio="none" className={className} aria-hidden="true">
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
  );
}
