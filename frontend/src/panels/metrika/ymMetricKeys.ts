/**
 * «Яндекс.Метрика» metric-route keys — the `ym-*` family behind `/metrics/:key`. Kept in a tiny
 * dependency-free module so the metric-route dispatcher (panels/IgMetricPage → MetricRoute) and
 * networks.routeNetworkOwner can recognise a YM drill target WITHOUT pulling the heavy YmMetricPage
 * chunk into the TG/IG metric bundle: the page itself is lazy-loaded only when a `ym-*` key opens.
 *
 * The set mirrors Обзор /metrika one-for-one: three real day-series (visits/users/pageviews), the
 * hourly rhythm heatmap, and fourteen breakdown/list reports. Order follows the Обзор board.
 */
export const YM_METRIC_KEYS = [
  // Real day-series (Line/Bar + comparison from the ym_daily archive).
  'ym-visits',
  'ym-users',
  'ym-pageviews',
  // Hourly rhythm — its own heatmap shape, no Line/Bar/comparison.
  'ym-hourly',
  // Breakdown / list reports — full list, no fabricated chart/comparison.
  'ym-sources',
  'ym-referrers',
  'ym-social',
  'ym-messengers',
  'ym-devices',
  'ym-countries',
  'ym-cities',
  'ym-age',
  'ym-gender',
  'ym-goals',
  'ym-utm',
  'ym-pages',
  'ym-landings',
  'ym-exits',
] as const;

export type YmMetricKey = (typeof YM_METRIC_KEYS)[number];

export function isYmMetricKey(key: string | undefined): key is YmMetricKey {
  return key != null && (YM_METRIC_KEYS as readonly string[]).includes(key);
}
