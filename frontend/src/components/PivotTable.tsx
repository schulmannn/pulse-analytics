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
 * chart-class data paint that makes the hot cells pop without a legend. Presentational;
 * the page supplies the aggregated matrix.
 */
export function PivotTable({ columns, rows, valueFmt }: PivotTableProps) {
  if (rows.length === 0 || columns.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        Нет данных за период
      </div>
    );
  }
  const globalMax = Math.max(...rows.flatMap((r) => r.values.map((v) => v ?? 0)), 0);
  // Inline hsl is data-driven paint (same class as SVG chart fills): the alpha can't be a
  // static utility. Primary-blue ramp like steep's pivot theme.
  const tint = (v: number | null): React.CSSProperties | undefined =>
    v == null || globalMax <= 0
      ? undefined
      : { backgroundColor: `hsl(var(--primary) / ${(0.06 + 0.42 * Math.min(v / globalMax, 1)).toFixed(3)})` };

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm" style={{ minWidth: Math.max(columns.length * 72 + 96, 320) }}>
        <thead>
          <tr>
            <th aria-hidden="true" className="w-24 py-1.5 pr-2" />
            {columns.map((c) => (
              <th key={c.key} className="px-0.5 py-1.5 text-right text-2xs font-medium tabular-nums text-muted-foreground">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td className="py-0.5 pr-2 text-xs text-muted-foreground">{row.label}</td>
              {row.values.map((value, i) => (
                <td key={columns[i].key} className="px-0.5 py-0.5">
                  <div className="relative overflow-hidden rounded px-2 py-1.5 text-right tabular-nums">
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
