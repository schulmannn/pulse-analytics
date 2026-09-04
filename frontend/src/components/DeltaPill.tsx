import type { MetricDelta } from '@/lib/delta';

/**
 * Shared trend indicator, deliberately QUIET (steep register): a muted ↑/↓ + percentage with no
 * evaluative colour and no tinted chip — direction lives in the arrow, judgement stays with the
 * reader (владелец: «ничего не кричит»). Hidden when flat or unknown. Single source of truth for
 * KPI cards, the drill-down, the comparison tables, and the IG panel. Positive/negative COLOUR
 * belongs to the ONE evaluated period-vs-period Δ of a comparison rail (`ComparisonDeltaRow`) and
 * to chart roles (DivergingBars) — never to this chip.
 */
/**
 * Текст дельты — или null, если печатать нечего. Вынесен из компонента, чтобы хост мог СПРОСИТЬ,
 * заговорит ли пилюля, и поставить свой честный заменитель вместо пустого места (см. CompactStatHeadline).
 */
export function deltaLabel(delta?: MetricDelta | null): string | null {
  if (!delta || delta.dir === 'flat') return null;
  const percentage = delta.pct >= 100 ? delta.pct.toFixed(0) : delta.pct.toFixed(1);
  // «↑0.0%» — заявка на движение, которую опровергает само же напечатанное число. Ниже разрешения
  // печати направление недоказуемо, и стрелка молчит так же, как на flat (аудит #554, найдено при D9).
  if (Number.parseFloat(percentage) === 0) return null;
  return `${delta.dir === 'up' ? '↑' : '↓'}${percentage}%`;
}

export function DeltaPill({ delta }: { delta?: MetricDelta | null }) {
  const label = deltaLabel(delta);
  if (label == null) return null;
  return <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">{label}</span>;
}
