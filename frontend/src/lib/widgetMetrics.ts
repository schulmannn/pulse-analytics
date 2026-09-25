// Каталог виджетов Главной — `MetricDef[]`: ЧТО такое каждое число доски (подпись, источник,
// форма, единица, вид по умолчанию и допустимые виды, измерения разбивки, группа).
//
// С U05 это тонкая обёртка над двумя слоями единого каталога метрик:
//   - lib/metricIndex.ts — структура (источник, единица, форма, виды, seriesAgg, drillKey/drillTo…);
//   - panels/**/*MetricInfo.ts — тексты ⓘ (подпись, «как считается», «что входит», «откуда число»).
// Экспорты, типы и форма объектов прежние: потребители на индекс пока не переведены. Новую метрику
// виджета добавляют в WIDGET_SPECS индекса и в *MetricInfo.ts своего источника, не сюда.
//
// Модуль по-прежнему ЧИСТЫЕ ДАННЫЕ + ТИПЫ — без React, без запросов, без форматирования. Он не
// считает: MetricDef говорит, что метрика ЕСТЬ, а не как её получить (это работа резолвера).

import type { DrillKey } from '@/lib/kpiDerive';
import type { MetricInfo } from '@/lib/metricDetails';
import {
  METRIC_INDEX,
  WIDGET_METRIC_IDS,
  type MetricCategory,
  type MetricIndexSource,
  type MetricShape,
  type MetricUnit,
  type SeriesAggregation,
  type WidgetViz,
} from '@/lib/metricIndex';
import type { WidgetSize } from '@/lib/widgetPrefsStore';
import { IG_METRIC_INFO } from '@/panels/igMetricInfo';
import { YM_METRIC_INFO } from '@/panels/metrika/ymMetricInfo';
import { MS_METRIC_INFO } from '@/panels/sklad/msMetricInfo';
import { TG_METRIC_INFO } from '@/panels/tgMetricInfo';

export type { MetricCategory, MetricUnit, SeriesAggregation, WidgetViz } from '@/lib/metricIndex';

/** Where the metric's data comes from. `all` = source-agnostic (rare; reserved). */
export type MetricSource = 'tg' | 'ig' | 'ms' | 'ym' | 'all';

/** The metric's natural data shape — drives which visualisations make sense.
 *   - value      → a scalar (+ optional delta): a KPI headline (ER now, ERV, virality);
 *   - series     → a time series (+ a headline sum/last): views, subscribers, reactions;
 *   - breakdown  → a categorical split: emoji, sources, languages, formats, demographics;
 *   - table      → tabular rows: the weekly table, top posts.
 * (В индексе каталога это `MetricShape`; `kind` индекса — тип ряда flow | stock | ratio.) */
export type MetricKind = MetricShape;

/** Runtime strategy used by the widget resolver. Keeping the strategy on the metric definition
 * makes catalogue coverage explicit: a new metric is either wired to a resolver family or marked
 * unavailable on widget surfaces on purpose. */
export type MetricResolver =
  | 'tg.core'
  | 'tg.ratio'
  | 'tg.netGrowth'
  | 'tg.breakdown'
  | 'ig'
  | 'ms'
  | 'ym'
  | 'unavailable';

export interface MetricDef {
  /** Stable, source-namespaced id (e.g. `tg.views`, `ig.reach`). The WidgetConfig references this. */
  id: string;
  /** Display title (matches the card label users already know). */
  label: string;
  /** Optional longer explanatory title used inside metric tooltips. */
  glossaryLabel?: string;
  source: MetricSource;
  kind: MetricKind;
  unit: MetricUnit;
  category: MetricCategory;
  resolver: MetricResolver;
  /** The presentation a fresh widget of this metric opens with. Always ∈ `supportedViz`. */
  defaultViz: WidgetViz;
  /** Every presentation this metric may be shown as (drives the editor's type carousel). */
  supportedViz: WidgetViz[];
  /** Breakdown dimensions this metric can split by (dimension ids; the catalogue is formalised in
   *  S7). Only meaningful for series/breakdown metrics with per-item attribution. */
  dimensions?: string[];
  /** Grain-combination rule for series metrics (S10). Omitted → `flow`. */
  seriesAgg?: SeriesAggregation;
  /** Ties a core TG metric to its kpiDerive DrillKey so the resolver (S3) reuses deriveKpis for the
   *  value/delta/headline without re-deriving. Only the six KPI metrics carry this. */
  drillKey?: DrillKey;
  /** Absolute drill path for metrics БЕЗ страницы /metrics/:drillKey (МС-виджеты ведут на /sklad).
   *  Взаимоисключим с drillKey; та же охрана «пин ≠ активный канал» действует в ConfigWidget. */
  drillTo?: string;
  /** For a BREAKDOWN metric: does summing all its categories yield a meaningful TOTAL (a complete,
   *  additive count — e.g. total engagement / total views by source)? If so the resolver sets that
   *  total as the card's hero value, so a distribution card leads with a headline number instead of
   *  straight into the chart (steep #4.9). Omit for averages / percentages / top-N partials, where a
   *  sum is nonsense. */
  additive?: boolean;
  // ── Plain-language definition (surfaced in the «О метрике» block) ──
  /** How it's calculated, in words. */
  formula?: string;
  /** What's included / a clarifying note. */
  included?: string;
  /** Where the number comes from (separate from the `source` tg/ig/all field above). */
  sourceNote?: string;
}

const INFO: Readonly<Record<string, MetricInfo>> = {
  ...TG_METRIC_INFO,
  ...IG_METRIC_INFO,
  ...MS_METRIC_INFO,
  ...YM_METRIC_INFO,
};

function catalogueSource(source: MetricIndexSource): MetricSource {
  return source === 'tg' || source === 'ig' || source === 'ms' || source === 'ym' ? source : 'all';
}

function resolverFor(def: Pick<MetricDef, 'id' | 'source' | 'kind' | 'drillKey'>): MetricResolver {
  if (def.source === 'ig') return 'ig';
  if (def.source === 'ms') return 'ms';
  if (def.source === 'ym') return 'ym';
  if (def.drillKey) return 'tg.core';
  if (def.id === 'tg.erv' || def.id === 'tg.virality') return 'tg.ratio';
  if (def.id === 'tg.netGrowth') return 'tg.netGrowth';
  if (def.source === 'tg' && def.kind === 'breakdown') return 'tg.breakdown';
  return 'unavailable';
}

/** Индекс (структура) + тексты источника → прежний MetricDef. Необязательные поля появляются
 *  только там, где они заданы, как у прежних литералов каталога. */
function toMetricDef(id: string): MetricDef | null {
  const entry = METRIC_INDEX[id];
  const widget = entry?.widget;
  const info = INFO[id];
  if (!entry || !widget || !info) return null;
  const def: MetricDef = {
    id,
    label: info.label,
    ...(info.glossaryLabel != null ? { glossaryLabel: info.glossaryLabel } : {}),
    source: catalogueSource(entry.source),
    kind: widget.shape,
    unit: entry.unit,
    category: widget.category,
    resolver: 'unavailable',
    defaultViz: widget.defaultViz,
    supportedViz: [...widget.supportedViz],
    ...(widget.dimensions ? { dimensions: [...widget.dimensions] } : {}),
    ...(widget.seriesAgg ? { seriesAgg: widget.seriesAgg } : {}),
    ...(widget.drillKey ? { drillKey: widget.drillKey } : {}),
    ...(widget.drillTo ? { drillTo: widget.drillTo } : {}),
    ...(widget.additive != null ? { additive: widget.additive } : {}),
    ...(info.formula != null ? { formula: info.formula } : {}),
    ...(info.included != null ? { included: info.included } : {}),
    ...(info.sourceNote != null ? { sourceNote: info.sourceNote } : {}),
  };
  def.resolver = resolverFor(def);
  return def;
}

/** The full catalogue — TG first, then IG, then МС и Метрика, in a sensible reading order per source. */
export const WIDGET_METRICS: MetricDef[] = WIDGET_METRIC_IDS.map(toMetricDef).filter(
  (def): def is MetricDef => def != null,
);

/** id → MetricDef for O(1) lookup (the WidgetConfig resolves its metric through this). */
export const METRIC_BY_ID: Record<string, MetricDef> = Object.fromEntries(
  WIDGET_METRICS.map((m) => [m.id, m]),
);

export const METRIC_BY_DRILL_KEY: Partial<Record<DrillKey, MetricDef>> = Object.fromEntries(
  WIDGET_METRICS.filter((metric) => metric.drillKey).map((metric) => [metric.drillKey, metric]),
);

export function getMetric(id: string): MetricDef | undefined {
  return METRIC_BY_ID[id];
}

/** Canonical definition for one of kpiDerive's six TG drill metrics. The catalogue invariant is
 * covered by tests, so consumers no longer need a parallel, un-namespaced glossary map. */
export function getDrillMetric(key: DrillKey): MetricDef {
  const metric = METRIC_BY_DRILL_KEY[key];
  if (!metric) throw new Error(`Missing metric definition for drill key: ${key}`);
  return metric;
}

export function isMetricId(raw: string | undefined | null): raw is string {
  return typeof raw === 'string' && raw in METRIC_BY_ID;
}

/** Metrics available for a source: `tg` / `ig` / `ms` / `ym` themselves plus any `all` (source-agnostic) ones. */
export function metricsForSource(source: 'tg' | 'ig' | 'ms' | 'ym'): MetricDef[] {
  return WIDGET_METRICS.filter((m) => m.source === source || m.source === 'all');
}

/** A sensible default footprint for a fresh widget of this metric (U4): a KPI reads at a third, a
 *  donut wants a compact square, a table needs the full row, everything else (line/bar/list) a half.
 *  Seeds `defaultWidget().size` so a new card lands well-proportioned instead of always half. */
export function recommendedSize(metric: MetricDef): WidgetSize {
  if (metric.kind === 'table') return 'full';
  if (metric.kind === 'value') return 'third';
  if (metric.defaultViz === 'donut') return 'third';
  return 'half';
}

/** Human labels + display order for the four catalogue categories (S6 modal groups / headers). */
export const CATEGORY_LABEL: Record<MetricCategory, string> = {
  growth: 'Рост',
  engagement: 'Вовлечённость',
  content: 'Контент',
  audience: 'Аудитория',
};
export const CATEGORY_ORDER: MetricCategory[] = ['growth', 'engagement', 'content', 'audience'];
