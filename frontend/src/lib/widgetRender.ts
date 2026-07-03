// Pure presentation helpers for the WidgetRenderer — the formatting-free WidgetResult carries raw
// bucket KEYS and numbers; these turn them into display labels + tooltip titles. Kept out of the
// React component so the label/formatting logic is unit-testable (the component itself is just
// wiring the charts). No React here.

import { fmt } from '@/lib/format';
import type { MetricUnit, WidgetViz } from '@/lib/widgetMetrics';
import type { WidgetResult } from '@/lib/resolveWidgetMetric';

/** A bucket key → display label. Month keys (`YYYY-MM`) → localized short month; day/week keys
 *  (`YYYY-MM-DD`) → the day formatter (mirrors MetricPage's bucketLabelOf). */
export function bucketLabel(key: string): string {
  if (/^\d{4}-\d{2}$/.test(key)) {
    return new Date(`${key}-01T00:00:00Z`).toLocaleDateString('ru-RU', { month: 'short', timeZone: 'UTC' });
  }
  return fmt.day(key);
}

/** Russian labels for the visualisation vocabulary — shared by the catalogue + the editor. */
export const VIZ_LABEL: Record<WidgetViz, string> = {
  kpi: 'Число',
  line: 'Линия',
  bar: 'Столбцы',
  donut: 'Круговая',
  list: 'Список',
  rank: 'Рейтинг',
  pivot: 'Сводная',
  table: 'Таблица',
  ledger: 'Значения',
};

/** The number formatter for a unit: percent → «6.5%», views → compact (fmt.short), else fmt.num. */
export function unitFormat(unit: MetricUnit): (n: number) => string {
  if (unit === 'percent') return (n) => `${n.toFixed(1)}%`;
  if (unit === 'views') return (n) => fmt.short(n);
  return (n) => fmt.num(n); // number / posts
}

export interface ChartSeries {
  values: number[];
  labels: string[];
  titles: string[];
}

/** Adapt a WidgetResult's series into the {values,labels,titles} the chart components take. */
export function seriesToChart(result: WidgetResult): ChartSeries {
  const series = result.series ?? [];
  const f = unitFormat(result.unit);
  const labels = series.map((p) => bucketLabel(p.date));
  const values = series.map((p) => p.value);
  const titles = series.map((p, i) => `${labels[i]}: ${f(p.value)}`);
  return { values, labels, titles };
}

/** Tooltip titles for a breakdown («label: display») — uses the pre-formatted `display` when set. */
export function breakdownTitles(result: WidgetResult): string[] {
  const items = result.breakdown ?? [];
  const f = unitFormat(result.unit);
  return items.map((i) => `${i.label}: ${i.display ?? f(i.value)}`);
}

/**
 * The visualisation actually rendered: honour the requested `viz` when the result carries the data
 * it needs, else gracefully fall back to what the data IS — so a stale/rank/pivot/table choice never
 * renders blank. series → line/bar; breakdown → list/donut; scalar → kpi.
 */
export function effectiveViz(viz: WidgetViz, hasSeries: boolean, hasBreakdown: boolean): WidgetViz {
  if (viz === 'line' || viz === 'bar') return hasSeries ? viz : hasBreakdown ? 'list' : 'kpi';
  if (viz === 'donut' || viz === 'list') return hasBreakdown ? viz : hasSeries ? 'line' : 'kpi';
  if (viz === 'kpi') return 'kpi';
  // rank / pivot / table / ledger — not yet rendered from a WidgetResult; fall back to the data shape.
  return hasBreakdown ? 'list' : hasSeries ? 'line' : 'kpi';
}
