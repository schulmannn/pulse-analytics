import type { MetricDelta } from '@/lib/delta';

/**
 * Shared shadcn-style outlined trend badge. Direction remains explicit in the arrow while the
 * restrained success/destructive tint makes KPI scanning faster than a bare muted percentage.
 */
export function DeltaPill({ delta, subtle = false }: { delta?: MetricDelta | null; subtle?: boolean }) {
  void subtle;
  if (!delta || delta.dir === 'flat') return null;
  const direction = delta.dir === 'up' ? '↑' : '↓';
  const percentage = delta.pct >= 100 ? delta.pct.toFixed(0) : delta.pct.toFixed(1);
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-2xs font-semibold tabular-nums shadow-sm ${
        delta.dir === 'up'
          ? 'border-verdant/20 bg-verdant/10 text-verdant'
          : 'border-destructive/20 bg-destructive/10 text-destructive'
      }`}
    >
      {direction}
      {percentage}%
    </span>
  );
}
