import type { MetricDelta } from '@/lib/delta';

/**
 * Shared trend indicator, deliberately QUIET (steep register): a muted ↑/↓ + percentage with no
 * evaluative colour and no tinted chip — direction lives in the arrow, judgement stays with the
 * reader (владелец: «ничего не кричит»). Hidden when flat or unknown. The `subtle` prop is kept
 * for call-site compatibility; both variants render the same quiet span now. Single source of
 * truth for KPI cards, the drill-down, the comparison tables, and the IG panel. Positive/negative
 * COLOUR remains reserved for chart roles (DivergingBars) and status surfaces — not this chip.
 */
export function DeltaPill({ delta, subtle = false }: { delta?: MetricDelta | null; subtle?: boolean }) {
  void subtle;
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
