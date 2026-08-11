// Public facade for widget metric resolution. Platform-specific calculations live under
// widgetResolver/, while this module owns only cross-cutting comparison, targets, and metadata.

import { movingAverageGhost, sameWeekdayGhost } from '@/lib/metricSeries';
import { getMetric } from '@/lib/widgetMetrics';
import type { MetricResolver, SeriesAggregation } from '@/lib/widgetMetrics';
import type { WidgetConfig } from '@/lib/widgetConfig';
import { resolveIgMetric } from '@/lib/widgetResolver/ig';
import { resolveMsMetric } from '@/lib/widgetResolver/ms';
import { resolveYmMetric } from '@/lib/widgetResolver/ym';
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

/**
 * Вид агрегации серии для недельного капа баров (capResultSeries): канон — `seriesAgg` каталога
 * (widgetMetrics), где 'level' = last-of-bucket, остальное — поток (сумма корзины).
 * Классификация ВСЕХ series-метрик каталога:
 *  - flow (сумма): tg.views, tg.reactions, tg.forwards, tg.netGrowth (сумма дневных
 *    нетто = нетто недели), ig.reach, ig.netFollowers, ig.interactions, ms.revenue, ms.orders;
 *  - level (last-of-bucket): tg.subscribers, ig.followers — каталог (`seriesAgg: 'level'`,
 *    серии bucketSubscriberLevels), плюс докласифицированный здесь ms.avgCheck: средний чек —
 *    не поток (сумма дневных СРЕДНИХ за неделю завышала бы значение на порядок), last-of-bucket
 *    сохраняет масштаб честно;
 *  - mean (среднее корзины): tg.avgReach — его серия это СРЕДНЕЕ на пост за день
 *    (bucketPostMean), и складывать средние нельзя: неделя завысилась бы кратно числу дней с
 *    публикациями. Раньше метрика стояла в flow, потому что её ряд был дневными СУММАМИ охвата.
 */
const SERIES_AGG_OVERRIDES: Record<string, SeriesAggregation> = { 'ms.avgCheck': 'level' };

function seriesAggOf(metricId: string): SeriesAggregation {
  return getMetric(metricId)?.seriesAgg ?? SERIES_AGG_OVERRIDES[metricId] ?? 'flow';
}

const WIDGET_RESOLVERS: Record<MetricResolver, WidgetMetricResolver> = {
  ...TG_WIDGET_RESOLVERS,
  ig: resolveIgMetric,
  ms: resolveMsMetric,
  ym: resolveYmMetric,
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
  const network: 'tg' | 'ig' | 'ms' | 'ym' =
    source === 'ig' ? 'ig' : source === 'ms' ? 'ms' : source === 'ym' ? 'ym' : source === 'tg' ? 'tg' : ctx.ig && !ctx.tg ? 'ig' : 'tg';
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
    // Скользящее среднее и «день недели» строятся ПО СЕРИИ, поэтому пропуск пришлось бы чем-то
    // заместить — любой суррогат (0 или интерполяция) стал бы выдуманным сравнением. Честнее
    // сравнение не строить и сказать об этом.
    const values = result.series.map((point) => point.value);
    const gapFree = values.every((value): value is number => value != null);
    const ghost = !gapFree
      ? null
      : comparison.mode === 'moving_average'
        ? movingAverageGhost(values, 7)
        : sameWeekdayGhost(
            result.series.map((point) => point.date),
            values,
          );
    if (!gapFree) {
      result.meta = {
        ...result.meta,
        comparisonNote: 'сравнение недоступно — в периоде есть пропуски сбора',
      };
    } else if (ghost) {
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
    // Пропуски в знаменатель НЕ идут: среднее считается по наблюдениям, а не по календарю —
    // иначе неделя простоя сбора занижала бы «Среднее» ровно так же, как настоящий спад.
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    let observed = 0;
    for (const point of fullSeries) {
      if (point.value == null) continue;
      if (point.value > max) max = point.value;
      sum += point.value;
      observed++;
    }
    if (observed > 0) result.stats = { max, avg: sum / observed };
  }
  return capResultSeries(result, config.viz, seriesAggOf(config.metricId));
}
