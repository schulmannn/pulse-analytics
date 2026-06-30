import type { MetricDelta } from '@/lib/delta';

/**
 * Shared trend chip: ↑green / ↓red, hidden when flat or unknown. `subtle` renders a bare
 * coloured percentage (for tight rows); default renders a tinted pill that stays legible on
 * the white light-theme card. Single source of truth for KPI cards, the drill-down, the
 * comparison tables, and the IG panel.
 */
export function DeltaPill({ delta, subtle = false }: { delta?: MetricDelta | null; subtle?: boolean }) {
  if (!delta || delta.dir === 'flat') return null;
  const direction = delta.dir === 'up' ? '↑' : '↓';
  const color = delta.dir === 'up' ? 'text-verdant' : 'text-ember';
  const percentage = delta.pct >= 100 ? delta.pct.toFixed(0) : delta.pct.toFixed(1);
  if (subtle) {
    return (
      <span className={`shrink-0 text-xs font-semibold tabular-nums ${color}`}>
        {direction}
        {percentage}%
      </span>
    );
  }
  // ember-strong text on the ember tint clears AA in light mode (plain text-ember does not).
  const chip = delta.dir === 'up' ? 'text-verdant bg-verdant/10' : 'text-ember-strong bg-ember/10';
  return (
    <span className={`rounded-full ${chip} px-2 py-0.5 text-xs font-semibold tabular-nums`}>
      {direction}
      {percentage}%
    </span>
  );
}
