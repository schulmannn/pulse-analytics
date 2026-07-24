/**
 * Telegram «extra chart» metric-route keys — the `tg-*` family behind `/metrics/:key` for the
 * Analytics chart cards that were NOT part of the numeric KPI drill set (kpiDerive's DrillKey:
 * views/avgReach/reactions/forwards/er/subscribers → the steep MetricPage explorer). Those extra
 * cards — the activity heatmap and the views-velocity profile — used to open the generic in-place
 * `?detail=` overlay; they now drill to a dedicated full-screen route like every other chart card.
 *
 * Kept in a tiny dependency-free module (mirrors ymMetricKeys / msMetricKeys) so the metric-route
 * dispatcher (panels/IgMetricPage → MetricRoute) can recognise a `tg-*` extra drill target WITHOUT
 * pulling the TgMetricPage chunk into the shared metric bundle — the page is lazy-loaded only when a
 * `tg-*` key actually opens. `routeNetworkOwner` already resolves any non-ig/ms/ym `/metrics/*` key
 * to Telegram, so these need no entry there.
 *
 * NB: the numeric TG drill keys (views/avgReach/…/subscribers) are validated by kpiDerive.isDrillKey
 * inside MetricPage itself — this set is ONLY the non-DrillKey chart cards.
 */
export const TG_EXTRA_METRIC_KEYS = [
  // Activity heatmap — its own 7×24 grid shape, no Line/Bar/comparison.
  'tg-heatmap',
  // Views-velocity profile — cumulative accrual curve, genuine Line/Bar (no comparison baseline).
  'tg-velocity',
] as const;

export type TgExtraMetricKey = (typeof TG_EXTRA_METRIC_KEYS)[number];

export function isTgExtraMetricKey(key: string | undefined): key is TgExtraMetricKey {
  return key != null && (TG_EXTRA_METRIC_KEYS as readonly string[]).includes(key);
}
