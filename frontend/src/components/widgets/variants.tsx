import type { ReactNode } from 'react';
import { fmt } from '@/lib/format';
import { BarChart } from '@/components/BarChart';
import { Breakdown } from '@/components/Breakdown';
import { PieChart } from '@/components/PieChart';
import { DivergingBars } from '@/components/DivergingBars';
import type { WidgetSize } from '@/lib/widgetPrefsStore';

/** Rank the sizes so a variant's `minSize` can clamp the user's choice UP. */
export const SIZE_RANK: Record<WidgetSize, number> = { third: 0, half: 1, full: 2 };
/** Effective size = the larger of the user's choice and the active variant's floor. */
export function maxSize(a: WidgetSize, b: WidgetSize): WidgetSize {
  return SIZE_RANK[a] >= SIZE_RANK[b] ? a : b;
}

/** One presentation of a widget's data (line / bar / list …), chosen in the edit dialog. */
export interface WidgetVariant {
  key: string;
  label: string;
  /** Smallest footprint this presentation reads well at — clamps the card's size UP while the
      variant is active (default 'third'). The wide bar+ledger presentations set 'full'. */
  minSize?: WidgetSize;
  render: ReactNode;
}

export interface BreakdownLikeItem {
  label: string;
  value: number;
  display?: string;
  color?: string;
}

export interface LedgerRow {
  label: string;
  value: string;
}

/** Right-hand value list of the wide «Столбцы + значения» layout (steep Edit widget) —
    hairline rows like Breakdown minus the tint bars. Caps at 8 rows, «+N ещё» when more. */
export function ValueLedger({ rows }: { rows: LedgerRow[] }) {
  const shown = rows.slice(0, 8);
  const extra = rows.length - shown.length;
  return (
    <div className="w-56 shrink-0">
      {shown.map((row, i) => (
        <div
          key={i}
          className="flex items-baseline justify-between gap-3 border-b border-border py-1.5 last:border-b-0"
        >
          <span className="min-w-0 truncate text-xs text-muted-foreground">{row.label}</span>
          <span className="shrink-0 text-sm font-medium tabular-nums text-foreground">{row.value}</span>
        </div>
      ))}
      {extra > 0 && <div className="pt-1.5 text-2xs text-muted-foreground">+{extra} ещё</div>}
    </div>
  );
}

/** The wide chart+ledger row shared by the «Столбцы + значения» variants. */
export function BarValuesLayout({ chart, rows }: { chart: ReactNode; rows: LedgerRow[] }) {
  return (
    <div className="flex items-start gap-5">
      <div className="min-w-0 flex-1">{chart}</div>
      <ValueLedger rows={rows} />
    </div>
  );
}

/** The common «tint-row list ↔ bar chart ↔ pie» set for Breakdown-style category data, plus
    the wide «Столбцы + значения» presentation (bar chart + value ledger, needs the full row). */
export function breakdownVariants(items: BreakdownLikeItem[]): WidgetVariant[] {
  const values = items.map((i) => i.value);
  const labels = items.map((i) => i.label);
  const titles = items.map((i) => `${i.label}: ${i.display ?? i.value}`);
  return [
    { key: 'list', label: 'Список', render: <Breakdown items={items} /> },
    {
      key: 'bar',
      label: 'Столбцы',
      render: <BarChart values={values} labels={labels} titles={titles} />,
    },
    {
      key: 'pie',
      label: 'Круговая',
      render: <PieChart values={values} labels={labels} titles={titles} colors={items.map((i) => i.color)} />,
    },
    {
      key: 'bar-values',
      label: 'Столбцы + значения',
      minSize: 'full',
      render: (
        <BarValuesLayout
          chart={<BarChart values={values} labels={labels} titles={titles} />}
          rows={items.map((i) => ({ label: i.label, value: i.display ?? fmt.num(i.value) }))}
        />
      ),
    },
  ];
}


/** Reorder a variants list so `key` renders as the default (first) presentation. */
export function reorderDefault(variants: WidgetVariant[], key: string): WidgetVariant[] {
  const i = variants.findIndex((v) => v.key === key);
  return i > 0 ? [variants[i], ...variants.slice(0, i), ...variants.slice(i + 1)] : variants;
}

export interface SeriesBarValuesOptions {
  /** Delta series: diverging bars around a zero baseline instead of zero-based columns. */
  diverging?: boolean;
  /** Ledger value formatter (default fmt.num). */
  format?: (v: number) => string;
  /** Append «Сумма за период» (flow metrics only — summing levels reads as nonsense). */
  sum?: boolean;
  /** Label for the sum row (e.g. «Δ за период» when the plotted values are deltas). */
  sumLabel?: string;
  /** Extra ledger rows PREPENDED to the stats (e.g. «Сейчас» — the current level beside
      a delta chart). */
  extraRows?: LedgerRow[];
}

/** The wide «Столбцы + значения» variant for SERIES charts: bars (flex-1) plus a right-hand
    SUMMARY ledger (Последнее/Максимум/Минимум/Среднее[, Сумма]) — the side column must add
    what the chart itself can't show, never re-list the same per-day points (steep). */
export function seriesBarValuesVariant(
  values: number[],
  labels: string[],
  titles: string[],
  opts: SeriesBarValuesOptions = {},
): WidgetVariant {
  const format = opts.format ?? ((v: number) => fmt.num(v));
  let rows: LedgerRow[] = opts.extraRows ? [...opts.extraRows] : [];
  if (values.length > 0) {
    const last = values[values.length - 1];
    const max = Math.max(...values);
    const min = Math.min(...values);
    const sum = values.reduce((a, b) => a + b, 0);
    rows = rows.concat([
      { label: 'Последнее', value: format(last) },
      { label: 'Максимум', value: format(max) },
      { label: 'Минимум', value: format(min) },
      { label: 'Среднее', value: format(Math.round(sum / values.length)) },
      ...(opts.sum ? [{ label: opts.sumLabel ?? 'Сумма за период', value: format(sum) }] : []),
    ]);
  }
  return {
    key: 'bar-values',
    label: 'Столбцы + значения',
    minSize: 'full',
    render: (
      <BarValuesLayout
        chart={
          opts.diverging ? (
            <DivergingBars values={values} labels={labels} titles={titles} />
          ) : (
            <BarChart values={values} labels={labels} titles={titles} />
          )
        }
        rows={rows}
      />
    ),
  };
}
