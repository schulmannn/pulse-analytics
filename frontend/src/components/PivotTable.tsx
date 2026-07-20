import { EmptyState } from '@/components/EmptyState';

export interface PivotColumn {
  key: string;
  label: string;
}

export interface PivotRow {
  label: string;
  values: (number | null)[];
}

interface PivotTableProps {
  columns: PivotColumn[];
  rows: PivotRow[];
  valueFmt: (n: number) => string;
}

/**
 * Pivot table (steep «Values & colors»): categories × time buckets, every cell carries the
 * value AND a blue fill whose alpha ramps with the value's share of the global max — the
 * chart-class data paint that makes the hot cells pop without a legend. Wrapped in a rounded,
 * bordered shell with a calm header and a sticky row-label column so wide matrices scroll
 * horizontally while the labels stay anchored. Presentational; the page supplies the matrix.
 */
export function PivotTable({ columns, rows, valueFmt }: PivotTableProps) {
  if (rows.length === 0 || columns.length === 0) {
    return <EmptyState compact title="Нет данных за период" className="flex h-40 items-center justify-center" />;
  }
  const globalMax = Math.max(...rows.flatMap((r) => r.values.map((v) => v ?? 0)), 0);
  // Inline hsl is data-driven paint (same class as SVG chart fills): the alpha can't be a
  // static utility. Primary-blue ramp like steep's pivot theme.
  const tint = (v: number | null): React.CSSProperties | undefined =>
    v == null || globalMax <= 0
      ? undefined
      : { backgroundColor: `hsl(var(--chart-role-primary) / ${(0.06 + 0.42 * Math.min(v / globalMax, 1)).toFixed(3)})` };

  return (
    <div data-pivot-table className="overflow-x-auto rounded-xl border border-border dark:border-white/[0.06]">
      <table className="w-full border-collapse text-sm" style={{ minWidth: Math.max(columns.length * 76 + 112, 320) }}>
        <thead>
          <tr className="border-b border-border dark:border-white/[0.06]">
            <th
              aria-hidden="true"
              className="sticky left-0 z-10 w-28 bg-card px-3 py-2"
            />
            {columns.map((c) => (
              <th scope="col" key={c.key} className="px-1.5 py-2 text-right text-2xs font-medium tabular-nums text-muted-foreground">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-t border-border first:border-t-0 dark:border-white/[0.04]">
              <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-1.5 text-left text-xs font-normal text-muted-foreground">{row.label}</th>
              {row.values.map((value, i) => (
                <td key={columns[i].key} className="px-1 py-1">
                  <div className="relative overflow-hidden rounded-md px-2 py-1.5 text-right tabular-nums">
                    <div aria-hidden="true" className="absolute inset-0" style={tint(value)} />
                    <span className="relative text-foreground">{value == null ? '—' : valueFmt(value)}</span>
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
