import { getMetric } from '@/lib/widgetMetrics';
import { pluralRu } from '@/lib/resolveWidgetMetric';
import type { WidgetMeta } from '@/lib/resolveWidgetMetric';

/**
 * Metric explainability rows — «почему это число такое». Composes the STATIC catalogue definition
 * (formula / included / source note per MetricDef) with the DYNAMIC per-render facts already resolved
 * into WidgetResult.meta (period · sample size · data freshness / last sync · comparison caveat). Pure
 * so it unit-tests without the React/InfoTooltip import chain; the MetricExplain component renders it.
 */

export interface ExplainRow {
  label: string;
  text: string;
  /** Data-quality caution (stale data, suppressed comparison) — rendered in the warn tone. */
  warn?: boolean;
}

/** The sample-size line: filtered in-window posts, else archive days behind a series. */
export function sampleText(meta?: WidgetMeta): string | null {
  if (meta?.samplePosts != null && meta.samplePosts > 0)
    return `${meta.samplePosts} ${pluralRu(meta.samplePosts, ['пост', 'поста', 'постов'])}`;
  if (meta?.archiveDays != null && meta.archiveDays > 0) return `${meta.archiveDays} дн. в архиве`;
  return null;
}

/** The ordered explain rows for a metric + its resolved meta. Empty → nothing to explain. */
export function explainRows(metricId: string | undefined, meta?: WidgetMeta): ExplainRow[] {
  const def = metricId ? getMetric(metricId) : undefined;
  const rows: ExplainRow[] = [];
  if (def?.formula) rows.push({ label: 'Как считается', text: def.formula });
  if (def?.included) rows.push({ label: 'Что учитывается', text: def.included });
  if (def?.sourceNote) rows.push({ label: 'Источник', text: def.sourceNote });
  if (meta?.periodLabel) rows.push({ label: 'Период', text: meta.periodLabel });
  const sample = sampleText(meta);
  if (sample) rows.push({ label: 'Выборка', text: sample });
  if (meta?.fresh) rows.push({ label: 'Данные', text: meta.fresh.label, warn: meta.fresh.stale });
  if (meta?.comparisonNote) rows.push({ label: 'Сравнение', text: meta.comparisonNote, warn: true });
  return rows;
}

/** Metric display label for the tooltip heading (catalogue label, else a generic fallback). */
export function metricLabel(metricId?: string): string {
  return (metricId ? getMetric(metricId)?.label : undefined) || 'Метрика';
}
