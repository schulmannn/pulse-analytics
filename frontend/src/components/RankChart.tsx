import { EmptyState } from '@/components/EmptyState';

export interface RankItem {
  label: string;
  value: number;
  /** Baseline value (previous period / last year) — enables the paired bar + Δ%. */
  compare?: number | null;
}

interface RankChartProps {
  items: RankItem[];
  valueFmt: (n: number) => string;
  /** Legend name for the baseline series; null/undefined hides the compare layer. */
  compareLabel?: string | null;
}

/** ▲/▼ percent vs the baseline (steep's rank-chart delta column). */
function DeltaText({ current, base }: { current: number; base: number | null | undefined }) {
  if (base == null || base <= 0) return null;
  const d = ((current - base) / base) * 100;
  return (
    <span className="text-xs font-medium tabular-nums text-muted-foreground">
      {d >= 0 ? '▲' : '▼'}
      {Math.abs(d).toFixed(1)}%
    </span>
  );
}

/**
 * Rank chart (steep): categories sorted by value as horizontal bars — the current period in
 * accent blue, the baseline as a quieter bar underneath, value + Δ% on the right and a total
 * row at the bottom. Pure presentational; the page supplies aggregated items.
 */
export function RankChart({ items, valueFmt, compareLabel }: RankChartProps) {
  if (items.length === 0) {
    return <EmptyState compact title="Нет данных за период" className="flex h-40 items-center justify-center" />;
  }
  const showCompare = compareLabel != null && items.some((i) => i.compare != null);
  const max = Math.max(...items.map((i) => Math.max(i.value, i.compare ?? 0)), 1);
  const totalCur = items.reduce((s, i) => s + i.value, 0);
  const totalBase = showCompare ? items.reduce((s, i) => s + (i.compare ?? 0), 0) : null;

  return (
    <div>
      <div className="space-y-4">
        {items.map((item) => (
          <div key={item.label} className="grid grid-cols-[minmax(72px,auto)_1fr_auto] items-center gap-3">
            <div className="truncate text-sm text-foreground">{item.label}</div>
            <div className="min-w-0 space-y-1">
              <div
                className="h-4 rounded-sm"
                style={{ backgroundColor: 'hsl(var(--chart-role-primary) / 0.85)', width: `${Math.max((item.value / max) * 100, item.value > 0 ? 1.5 : 0)}%` }}
              />
              {showCompare && item.compare != null && (
                <div
                  className="h-3 rounded-sm"
                  style={{ backgroundColor: 'hsl(var(--chart-role-comparison) / 0.35)', width: `${Math.max((item.compare / max) * 100, item.compare > 0 ? 1.5 : 0)}%` }}
                />
              )}
            </div>
            <div className="flex items-baseline gap-2 justify-self-end">
              <span className="text-sm font-medium tabular-nums">{valueFmt(item.value)}</span>
              {showCompare && <DeltaText current={item.value} base={item.compare} />}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-border pt-2">
        <span className="text-sm font-medium">Итого</span>
        <span className="flex items-baseline gap-2">
          <span className="text-sm font-medium tabular-nums">{valueFmt(totalCur)}</span>
          {totalBase != null && <DeltaText current={totalCur} base={totalBase} />}
        </span>
      </div>

      {showCompare && (
        <p className="mt-2 text-2xs text-muted-foreground">
          <span aria-hidden="true" className="mr-1.5 inline-block h-2 w-3 rounded-sm align-middle" style={{ backgroundColor: 'hsl(var(--chart-role-primary) / 0.85)' }} />
          текущий период
          <span aria-hidden="true" className="mx-1.5 ml-3 inline-block h-2 w-3 rounded-sm align-middle" style={{ backgroundColor: 'hsl(var(--chart-role-comparison) / 0.35)' }} />
          {compareLabel}
        </p>
      )}
    </div>
  );
}
