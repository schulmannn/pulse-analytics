// One capability model for every widget (U6): the builder editor is driven by an EditorSpec — which
// controls apply, the label, the viz options, the filter dimensions — computed from a config whether
// it's a catalogue metric or a legacy composite. So the same WidgetConfigControls renders for both,
// just with a different set of enabled controls (a metric shows viz/grain/compare/filter/target; a
// legacy «Показатели» shows only the shell). Pure — no React.

import type { WidgetConfig } from '@/lib/widgetConfig';
import { getMetric, type WidgetViz } from '@/lib/widgetMetrics';
import { dimensionsFor, type DimensionDef } from '@/lib/dimensions';
import {
  LEGACY_CAPABILITIES,
  LEGACY_LABEL,
  LEGACY_SUPPORTED_VIZ,
  legacyKeyForMetricId,
  type WidgetCapabilities,
} from '@/lib/legacyWidgets';

const NO_CAPABILITIES: WidgetCapabilities = { metric: false, viz: false, grain: false, comparison: false, target: false, filter: false };

export interface EditorSpec {
  label: string;
  /** Visualisation options (empty / single → no viz control). */
  supportedViz: WidgetViz[];
  /** Filter dimensions available (empty → no filter control). */
  filterDims: DimensionDef[];
  capabilities: WidgetCapabilities;
  /** Why an ineligible control is off — the editor shows it DISABLED with this reason instead of
   *  silently omitting it, so the full control vocabulary is visible and the user learns why (steep).
   *  Populated only for catalogue metrics; legacy composites keep the bare shell (no disabled clutter). */
  disabledReasons?: Partial<Record<keyof WidgetCapabilities, string>>;
}

/** The editor spec for a config — catalogue metrics derive their capabilities from the MetricDef,
 *  legacy widgets from their adapter capabilities. */
export function editorSpec(config: WidgetConfig): EditorSpec {
  const legacyKey = legacyKeyForMetricId(config.metricId);
  if (legacyKey) {
    return {
      label: LEGACY_LABEL[legacyKey],
      supportedViz: LEGACY_SUPPORTED_VIZ[legacyKey],
      filterDims: [],
      capabilities: LEGACY_CAPABILITIES[legacyKey],
    };
  }
  const metric = getMetric(config.metricId);
  if (!metric) return { label: 'Метрика', supportedViz: [], filterDims: [], capabilities: NO_CAPABILITIES };

  const isSeries = metric.kind === 'series';
  const filterDims = dimensionsFor(metric.dimensions);
  // Donut для percent-breakdown исключён из словаря: интенсивность (ср. ERV по формату) — не
  // «части целого», donut рисовал бы доли от СУММЫ ERV («Фото 76.3%» — 76.3% чего?). Рендер
  // сохранённых donut-конфигов страхует effectiveViz (widgetRender) фолбэком в list.
  const supportedViz =
    metric.kind === 'breakdown' && metric.unit === 'percent'
      ? metric.supportedViz.filter((v) => v !== 'donut')
      : metric.supportedViz;
  const capabilities: WidgetCapabilities = {
    metric: false, // swapping the metric = a different widget (add a new one)
    viz: supportedViz.length > 1,
    // Grain / comparison / target only render on a series chart; filter needs dimensions.
    grain: isSeries,
    comparison: isSeries,
    target: isSeries,
    filter: filterDims.length > 0,
  };
  // Reasons for the controls this metric can't use — the editor shows them disabled, not hidden.
  const seriesOnly = 'Доступно только для метрик-рядов (динамика по времени)';
  const disabledReasons: Partial<Record<keyof WidgetCapabilities, string>> = {};
  if (!capabilities.viz) disabledReasons.viz = 'У этой метрики один тип графика';
  if (!capabilities.grain) disabledReasons.grain = seriesOnly;
  if (!capabilities.comparison) disabledReasons.comparison = seriesOnly;
  if (!capabilities.target) disabledReasons.target = seriesOnly;
  if (!capabilities.filter) disabledReasons.filter = 'У этой метрики нет измерений для фильтра';
  return { label: metric.label, supportedViz, filterDims, capabilities, disabledReasons };
}

/** Just the capabilities (for callers that don't need the label/viz/dims). */
export function capabilitiesFor(config: WidgetConfig): WidgetCapabilities {
  return editorSpec(config).capabilities;
}
