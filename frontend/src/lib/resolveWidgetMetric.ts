// Public facade for widget metric resolution. Platform-specific calculations live under
// widgetResolver/, while this module owns only cross-cutting comparison, targets, and metadata.

import { movingAverageGhost, sameWeekdayGhost } from '@/lib/metricSeries';
import { getMetric } from '@/lib/widgetMetrics';
import type { MetricResolver } from '@/lib/widgetMetrics';
import type { WidgetConfig } from '@/lib/widgetConfig';
import { resolveIgMetric } from '@/lib/widgetResolver/ig';
import { resolveMsMetric } from '@/lib/widgetResolver/ms';
import { COMPARISON_LABEL, capResultSeries, commonMeta, wantsGhostLine } from '@/lib/widgetResolver/shared';
import { TG_WIDGET_RESOLVERS } from '@/lib/widgetResolver/tg';
import type {
  DataContext,
  WidgetMetricResolver,
  WidgetResult,
} from '@/lib/widgetResolver/types';

export type {
  DataContext,
  IgDataContext,
  TgDataContext,
  WidgetBreakdownItem,
  WidgetLedgerRow,
  WidgetMeta,
  WidgetResult,
  WidgetSeriesPoint,
} from '@/lib/widgetResolver/types';
export { pluralRu } from '@/lib/format';

const unavailable: WidgetMetricResolver = (_metric, _config, _ctx, out) => ({ ...out, empty: true });

const WIDGET_RESOLVERS: Record<MetricResolver, WidgetMetricResolver> = {
  ...TG_WIDGET_RESOLVERS,
  ig: resolveIgMetric,
  ms: resolveMsMetric,
  unavailable,
};

function resolveMetricCore(config: WidgetConfig, ctx: DataContext): WidgetResult {
  const metric = getMetric(config.metricId);
  if (!metric) return { metricId: config.metricId, kind: 'value', unit: 'number', empty: true };
  const out: WidgetResult = { metricId: metric.id, kind: metric.kind, unit: metric.unit };
  return WIDGET_RESOLVERS[metric.resolver](metric, config, ctx, out);
}

function resolveTargetValue(config: WidgetConfig, ctx: DataContext): number | null {
  const target = config.target;
  if (!target) return null;
  if (target.type === 'fixed') {
    return target.value != null && Number.isFinite(target.value) && target.value > 0 ? target.value : null;
  }
  if (target.type === 'dynamic' && target.metricId && target.metricId !== config.metricId) {
    const targetMetric = getMetric(target.metricId);
    const currentMetric = getMetric(config.metricId);
    if (targetMetric && currentMetric && targetMetric.source === currentMetric.source) {
      const result = resolveMetricCore(
        { id: 'target', metricId: target.metricId, viz: targetMetric.defaultViz },
        ctx,
      );
      return typeof result.valueRaw === 'number' && Number.isFinite(result.valueRaw) && result.valueRaw > 0
        ? result.valueRaw
        : null;
    }
  }
  return null;
}

/** Resolve a widget against already-loaded source data. Unknown or deliberately unavailable
 * metrics return an honest empty result rather than throwing. */
export function resolveWidgetMetric(config: WidgetConfig, ctx: DataContext): WidgetResult {
  const result = resolveMetricCore(config, ctx);
  const source = getMetric(config.metricId)?.source;
  const network: 'tg' | 'ig' | 'ms' =
    source === 'ig' ? 'ig' : source === 'ms' ? 'ms' : source === 'tg' ? 'tg' : ctx.ig && !ctx.tg ? 'ig' : 'tg';
  result.meta = { ...commonMeta(config, ctx, network), ...result.meta };

  const comparison = config.comparison;
  if (
    comparison &&
    (comparison.mode === 'moving_average' || comparison.mode === 'same_weekday') &&
    wantsGhostLine(comparison) &&
    !result.empty &&
    !result.ghost &&
    result.series &&
    result.series.length >= 2
  ) {
    const ghost =
      comparison.mode === 'moving_average'
        ? movingAverageGhost(
            result.series.map((point) => point.value),
            7,
          )
        : sameWeekdayGhost(
            result.series.map((point) => point.date),
            result.series.map((point) => point.value),
          );
    if (ghost) {
      result.ghost = ghost;
      result.ghostLabel = COMPARISON_LABEL[comparison.mode];
      result.meta = { ...result.meta, comparisonNote: undefined };
    } else {
      result.meta = {
        ...result.meta,
        comparisonNote: 'сравнение по дню недели — только для дневных данных',
      };
    }
  }

  if (!result.empty && config.target) {
    const target = resolveTargetValue(config, ctx);
    if (target != null) {
      result.target = target;
      if (typeof result.valueRaw === 'number' && Number.isFinite(result.valueRaw)) {
        result.targetPct = (result.valueRaw / target) * 100;
      }
    }
  }

  // Визуальный кап — СТРОГО последним: все производные (хедлайн/дельта в резолверах, ghost'ы и
  // target выше, «Макс/Среднее» через stats) уже посчитаны от полной серии; кап меняет только
  // плотность точек на линии. Один вызов здесь покрывает TG/IG/MS-резолверы разом.
  const fullSeries = result.series;
  if (fullSeries && fullSeries.length >= 2) {
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    for (const point of fullSeries) {
      if (point.value > max) max = point.value;
      sum += point.value;
    }
    result.stats = { max, avg: sum / fullSeries.length };
  }
  return capResultSeries(result, config.viz);
}
