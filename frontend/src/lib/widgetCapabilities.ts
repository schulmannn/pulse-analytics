// One capability model for every widget (U6): the builder editor is driven by an EditorSpec — which
// controls apply, the label, the viz options, the filter dimensions — computed from a config whether
// it's a catalogue metric or a legacy composite. So the same WidgetConfigControls renders for both,
// just with a different set of enabled controls (a metric shows viz/grain/compare/filter/target; a
// legacy «Показатели» shows only the shell). Pure — no React.

import type { WidgetConfig } from '@/lib/widgetConfig';
import { getMetric, type WidgetViz } from '@/lib/widgetMetrics';
import { dimensionsFor, type DimensionDef } from '@/lib/dimensions';
import { LEGACY_CAPABILITIES, LEGACY_LABEL, legacyKeyForMetricId, type WidgetCapabilities } from '@/lib/legacyWidgets';

const NO_CAPABILITIES: WidgetCapabilities = { metric: false, viz: false, grain: false, comparison: false, target: false, filter: false };

export interface EditorSpec {
  label: string;
  /** Visualisation options (empty / single → no viz control). */
  supportedViz: WidgetViz[];
  /** Filter dimensions available (empty → no filter control). */
  filterDims: DimensionDef[];
  capabilities: WidgetCapabilities;
}

/** The editor spec for a config — catalogue metrics derive their capabilities from the MetricDef,
 *  legacy widgets from their adapter capabilities. */
export function editorSpec(config: WidgetConfig): EditorSpec {
  const legacyKey = legacyKeyForMetricId(config.metricId);
  if (legacyKey) {
    return { label: LEGACY_LABEL[legacyKey], supportedViz: [], filterDims: [], capabilities: LEGACY_CAPABILITIES[legacyKey] };
  }
  const metric = getMetric(config.metricId);
  if (!metric) return { label: 'Метрика', supportedViz: [], filterDims: [], capabilities: NO_CAPABILITIES };

  const isSeries = metric.kind === 'series';
  const filterDims = dimensionsFor(metric.dimensions);
  return {
    label: metric.label,
    supportedViz: metric.supportedViz,
    filterDims,
    capabilities: {
      metric: false, // swapping the metric = a different widget (add a new one)
      viz: metric.supportedViz.length > 1,
      // Grain / comparison / target only render on a series chart; filter needs dimensions.
      grain: isSeries,
      comparison: isSeries,
      target: isSeries,
      filter: filterDims.length > 0,
    },
  };
}

/** Just the capabilities (for callers that don't need the label/viz/dims). */
export function capabilitiesFor(config: WidgetConfig): WidgetCapabilities {
  return editorSpec(config).capabilities;
}
