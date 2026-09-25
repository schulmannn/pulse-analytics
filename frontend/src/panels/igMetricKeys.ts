/**
 * Instagram «chart card» metric-route keys — the `ig-*` family behind `/metrics/:key` for the IG
 * Аналитики/Аудитория/Контент CHART cards that were NOT part of the numeric daily/aggregate drill
 * set (reach/follows/views/…/er → the IgMetricPage explorer / period-comparison pages). These chart
 * cards used to open the generic in-place `?detail=` overlay; they now each drill to a dedicated
 * full-screen route like every other chart card, matching the ig-reach explorer and the tg/ym pages.
 *
 * Kept in a tiny dependency-free module (mirrors tgMetricKeys / ymMetricKeys) so the metric-route
 * dispatcher (`panels/MetricRoute`) can recognise every IG key without importing the heavy
 * `IgMetricPage` implementation. This is a hard route-splitting boundary, not only a convenience
 * registry: opening a generic Telegram metric must not download Instagram charts.
 * `routeNetworkOwner` already resolves any `ig-*` key to Instagram, so these need no extra entry
 * there.
 *
 * ЧЕСТНОСТЬ важнее паритета: the demographic/format/story-navigation cards are truthful rank lists,
 * the heatmap keeps its own 7×24 grid, and Reels is per-post categorical — none fabricates a
 * time-series, a Line/Bar choice, or a previous-period comparison the source card didn't have.
 */
export const IG_CHART_METRIC_KEYS = [
  // Demographics (follower_demographics snapshot) — truthful rank lists, no window/comparison.
  'ig-age', //         Аудитория: возраст подписчиков
  'ig-gender', //      Аудитория: пол подписчиков
  'ig-countries', //   Аудитория: топ стран
  'ig-cities', //      Аудитория: топ городов
  // Best-time heatmap — its own 7×24 grid shape, no Line/Bar/comparison.
  'ig-best-time', //   Аудитория: лучшее время для публикации (online_followers)
  // Format engagement — account interactions by format over the window (rank list).
  'ig-format-engagement', // Контент: вовлечённость по форматам
  // Reels watch time — per-post categorical bars (no fabricated period comparison).
  'ig-reels-watch-time', //  Контент: ср. время просмотра по Reels
  // Story navigation — summed tap/swipe actions over the 24h stories (rank list).
  'ig-story-navigation', //  Контент: навигация по историям
] as const;

/** Numeric/derived Instagram explorers owned by `IgMetricPage`. Keep this list next to the chart
 * route keys so the dispatcher stays dependency-free. `IgMetricPage` owns the matching definitions
 * and its tests keep those definitions in lockstep with this public route contract. */
export const IG_EXPLORER_METRIC_KEYS = [
  'ig-reach',
  'ig-follows',
  'ig-views',
  'ig-interactions',
  'ig-likes',
  'ig-saves',
  'ig-er',
] as const;

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
