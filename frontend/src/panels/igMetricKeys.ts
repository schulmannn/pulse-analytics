/**
 * Instagram «chart card» metric-route keys — the `ig-*` family behind `/metrics/:key` for the IG
 * Аналитики/Аудитория/Контент CHART cards that were NOT part of the numeric daily/aggregate drill
 * set (reach/follows/views/…/er → the IgMetricPage explorer / period-comparison pages). These chart
 * cards used to open the generic in-place `?detail=` overlay; they now each drill to a dedicated
 * full-screen route like every other chart card, matching the ig-reach explorer and the tg/ym pages.
 *
 * Kept in a tiny dependency-free module (mirrors tgMetricKeys / ymMetricKeys) so the metric-route
 * dispatcher (panels/IgMetricPage → MetricRoute) can fold these into `isIgMetricKey` without any
 * extra bundle cost. `routeNetworkOwner` already resolves any `ig-*` key to Instagram, so these need
 * no entry there.
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

export type IgChartMetricKey = (typeof IG_CHART_METRIC_KEYS)[number];

export function isIgChartMetricKey(key: string | undefined): key is IgChartMetricKey {
  return key != null && (IG_CHART_METRIC_KEYS as readonly string[]).includes(key);
}
