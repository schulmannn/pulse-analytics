/**
 * МойСклад metric-route keys — the `ms-*` family behind `/metrics/:key`. Kept in a tiny
 * dependency-free module so the metric-route dispatcher (panels/IgMetricPage → MetricRoute) and
 * networks.routeNetworkOwner can recognise an MS drill target WITHOUT pulling the heavy MsMetricPage
 * chunk into the TG/IG metric bundle: the page itself is lazy-loaded only when an `ms-*` key opens.
 */
export const MS_METRIC_KEYS = [
  'ms-revenue',
  'ms-orders',
  'ms-aov',
  'ms-customers',
  'ms-repeat',
  'ms-channels',
  'ms-funnel',
  'ms-products',
  'ms-returns',
  'ms-sales-channels',
  'ms-geography',
  'ms-top-customers',
  'ms-cohorts',
] as const;

export type MsMetricKey = (typeof MS_METRIC_KEYS)[number];

export function isMsMetricKey(key: string | undefined): key is MsMetricKey {
  return key != null && (MS_METRIC_KEYS as readonly string[]).includes(key);
}
