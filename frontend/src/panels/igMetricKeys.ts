/**
 * Instagram «chart card» metric-route keys — the `ig-*` family behind `/metrics/:key` for the IG
 * Аналитики/Аудитория/Контент CHART cards that were NOT part of the numeric daily/aggregate drill
 * set (reach/follows/views/…/er → the IgMetricPage explorer / period-comparison pages). These chart
 * cards used to open the generic in-place `?detail=` overlay; they now each drill to a dedicated
 * full-screen route like every other chart card, matching the ig-reach explorer and the tg/ym pages.
 *
 * Тонкая обёртка над lib/metricIndex.ts (U05): списки ключей живут в лёгком индексе каталога,
 * здесь — прежние имена экспорта. Индекс без зависимостей, поэтому диспетчер маршрута
 * (`panels/MetricRoute`) узнаёт каждый IG-ключ, не импортируя тяжёлую `IgMetricPage`. This is a hard
 * route-splitting boundary, not only a convenience registry: opening a generic Telegram metric must
 * not download Instagram charts. `routeNetworkOwner` already resolves any `ig-*` key to Instagram, so
 * these need no extra entry there.
 *
 * ЧЕСТНОСТЬ важнее паритета: the demographic/format/story-navigation cards are truthful rank lists,
 * the heatmap keeps its own 7×24 grid, and Reels is per-post categorical — none fabricates a
 * time-series, a Line/Bar choice, or a previous-period comparison the source card didn't have.
 */
import { IG_CHART_METRIC_KEYS, IG_EXPLORER_METRIC_KEYS } from '@/lib/metricIndex';

/** IG_EXPLORER_METRIC_KEYS — numeric/derived Instagram explorers owned by `IgMetricPage`. They stay
 * next to the chart route keys so the dispatcher remains dependency-free; `IgMetricPage` owns the
 * matching definitions and its tests keep them in lockstep with this public route contract. */
export { IG_CHART_METRIC_KEYS, IG_EXPLORER_METRIC_KEYS };

export type IgChartMetricKey = (typeof IG_CHART_METRIC_KEYS)[number];
export type IgExplorerMetricKey = (typeof IG_EXPLORER_METRIC_KEYS)[number];

export function isIgChartMetricKey(key: string | undefined): key is IgChartMetricKey {
  return key != null && (IG_CHART_METRIC_KEYS as readonly string[]).includes(key);
}

export function isIgMetricKey(
  key: string | undefined,
): key is IgChartMetricKey | IgExplorerMetricKey {
  return (
    key != null &&
    ((IG_EXPLORER_METRIC_KEYS as readonly string[]).includes(key) || isIgChartMetricKey(key))
  );
}
