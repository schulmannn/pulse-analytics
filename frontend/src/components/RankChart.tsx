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

/** ▲/▼ percent vs the baseline (steep's rank-chart delta column) — tinted by direction (gain/loss),
    the one place a rank row leans on colour, mirroring the comparison card's Δ badge. */
function DeltaText({ current, base }: { current: number; base: number | null | undefined }) {
  if (base == null || base <= 0) return null;
  const d = ((current - base) / base) * 100;
  const up = d >= 0;
  return (
    <span className={`text-xs font-medium tabular-nums ${up ? 'text-verdant' : 'text-ember'}`}>
      {up ? '▲' : '▼'}
      {Math.abs(d).toFixed(1)}%
    </span>
  );
}

/** Legend swatch for the current / baseline series (kept in sync with the paired bars below). */
function LegendSwatch({ token, alpha }: { token: string; alpha: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-2 w-3 rounded-sm align-middle"
      style={{ backgroundColor: `hsl(var(${token}) / ${alpha})` }}
    />
  );
}

/**
 * Rank chart (steep): categories sorted by value as horizontal bars — a rank number, the current
 * period in accent blue over a quiet track, the baseline as a quieter bar underneath, value + Δ% on
 * the right and a total row at the bottom. Restyled to sit inside the metric explorer's chart card
 * (matching its comparison legend). Pure presentational; the page supplies aggregated items.
 */
export function RankChart({ items, valueFmt, compareLabel }: RankChartProps) {
  if (items.length === 0) {
    return <EmptyState compact size="chart" title="Нет данных за период" />;
  }
  const showCompare = compareLabel != null && items.some((i) => i.compare != null);
  const max = Math.max(...items.map((i) => Math.max(i.value, i.compare ?? 0)), 1);
  const totalCur = items.reduce((s, i) => s + i.value, 0);
  const totalBase = showCompare ? items.reduce((s, i) => s + (i.compare ?? 0), 0) : null;

  return (
    <div data-rank-chart>
      <div className="space-y-3.5">
        {items.map((item, i) => (
          <div key={item.label} className="grid grid-cols-[auto_minmax(64px,auto)_1fr_auto] items-center gap-3">
            <div className="w-4 shrink-0 text-right text-2xs font-medium tabular-nums text-muted-foreground">{i + 1}</div>
            <div className="truncate text-sm text-foreground">{item.label}</div>
            <div className="min-w-0 space-y-1">
              {/* Current period — accent fill over a hairline track, so a short bar still reads. */}
              <div className="h-4 overflow-hidden rounded-sm bg-muted/60">
                <div
                  className="h-full rounded-sm"
                  style={{ backgroundColor: 'hsl(var(--chart-role-primary) / 0.9)', width: `${Math.max((item.value / max) * 100, item.value > 0 ? 2 : 0)}%` }}
                />
              </div>
              {showCompare && item.compare != null && (
                <div
                  className="h-2.5 rounded-sm"
                  style={{ backgroundColor: 'hsl(var(--chart-role-comparison) / 0.4)', width: `${Math.max((item.compare / max) * 100, item.compare > 0 ? 2 : 0)}%` }}
                />
              )}
            </div>
            <div className="flex items-baseline gap-2 justify-self-end">
              <span className="text-sm font-medium tabular-nums text-foreground">{valueFmt(item.value)}</span>
              {showCompare && <DeltaText current={item.value} base={item.compare} />}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
        <span className="text-sm font-medium text-foreground">Итого</span>
        <span className="flex items-baseline gap-2">
          <span className="text-sm font-medium tabular-nums text-foreground">{valueFmt(totalCur)}</span>
          {totalBase != null && <DeltaText current={totalCur} base={totalBase} />}
        </span>
      </div>

      {showCompare && (
        <p className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-2xs text-muted-foreground">
          <LegendSwatch token="--chart-role-primary" alpha={0.9} />
          <span>текущий период</span>
          <LegendSwatch token="--chart-role-comparison" alpha={0.4} />
          <span>{compareLabel}</span>
        </p>
      )}
    </div>
  );
}
