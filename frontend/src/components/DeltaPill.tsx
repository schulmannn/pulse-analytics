import type { MetricDelta } from '@/lib/delta';

/**
 * Shared trend indicator, deliberately QUIET (steep register): a muted ↑/↓ + percentage with no
 * evaluative colour and no tinted chip — direction lives in the arrow, judgement stays with the
 * reader (владелец: «ничего не кричит»). Hidden when flat or unknown. Single source of truth for
 * KPI cards, the drill-down, the comparison tables, and the IG panel. Positive/negative COLOUR
 * belongs to the ONE evaluated period-vs-period Δ of a comparison rail (`ComparisonDeltaRow`) and
 * to chart roles (DivergingBars) — never to this chip.
 */
export function DeltaPill({ delta }: { delta?: MetricDelta | null }) {
  if (!delta || delta.dir === 'flat') return null;
  const direction = delta.dir === 'up' ? '↑' : '↓';
  const percentage = delta.pct >= 100 ? delta.pct.toFixed(0) : delta.pct.toFixed(1);
  return (
    <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
      {direction}
      {percentage}%
    </span>
  );
}
