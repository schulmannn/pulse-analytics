/**
 * Telegram «extra chart» metric-route keys — the `tg-*` family behind `/metrics/:key` for the
 * Analytics chart cards that were NOT part of the numeric KPI drill set (kpiDerive's DrillKey:
 * views/avgReach/reactions/forwards/er/subscribers → the steep MetricPage explorer). These chart
 * cards used to open the generic in-place `?detail=` overlay; they now each drill to a dedicated
 * full-screen route like every other chart card, matching /metrics/ig-* and /metrics/ym-*.
 *
 * Kept in a tiny dependency-free module (mirrors ymMetricKeys / msMetricKeys) so the metric-route
 * dispatcher (panels/IgMetricPage → MetricRoute) can recognise a `tg-*` extra drill target WITHOUT
 * pulling the TgMetricPage chunk into the shared metric bundle — the page is lazy-loaded only when a
 * `tg-*` key actually opens. `routeNetworkOwner` already resolves any non-ig/ms/ym `/metrics/*` key
 * to Telegram, so these need no entry there.
 *
 * ЧЕСТНОСТЬ важнее паритета: heatmap/velocity keep their own shapes; the weekday/hour cards keep the
 * honest category Bar/Line the source card already offered; every categorical breakdown is a truthful
 * full-height rank list — none fabricates a time-series, a Line/Bar choice, or a previous-period
 * comparison the source card didn't have.
 *
 * NB: the numeric TG drill keys (views/avgReach/…/subscribers) are validated by kpiDerive.isDrillKey
 * inside MetricPage itself — this set is ONLY the non-DrillKey chart cards.
 */
export const TG_EXTRA_METRIC_KEYS = [
  // Activity heatmap — its own 7×24 grid shape, no Line/Bar/comparison.
  'tg-heatmap',
  // Views-velocity profile — cumulative accrual curve, genuine Line/Bar (no comparison baseline).
  'tg-velocity',
  // Category Bar/Line cards (weekday / hour axis — Line is truthful for a category series).
  'tg-weekday-reach', // Compare: avg reach per post by weekday
  'tg-weekday-views', // Audience: avg views per post by weekday
  'tg-post-count', //    Audience: post count by weekday
  'tg-hours', //         Audience: activity by hour of day (graphs)
  // Categorical breakdowns — truthful rank lists, no fabricated Line/Bar or comparison.
  'tg-format-views', //       Compare: total views per format
  'tg-hashtag-erv', //        Formats: hashtag ERV-lift (campaign-scoped)
  'tg-emoji', //              Formats: reactions by emoji (campaign-scoped)
  'tg-engagement-mix', //     Formats: engagement composition (campaign-scoped)
  'tg-reach-by-type', //      Formats: avg reach per media type (campaign-scoped)
  'tg-erv-by-format', //      Formats: avg ERV per media type (campaign-scoped)
  'tg-views-by-source', //    Audience: views by source (graphs)
  'tg-followers-by-source', //Audience: new followers by source (graphs)
  'tg-languages', //          Audience: audience languages (graphs)
  'tg-sentiment', //          Audience: reaction sentiment (graphs)
  'tg-churn', //              Dynamics: churn (join/left) over the window
] as const;

export type TgExtraMetricKey = (typeof TG_EXTRA_METRIC_KEYS)[number];

export function isTgExtraMetricKey(key: string | undefined): key is TgExtraMetricKey {
  return key != null && (TG_EXTRA_METRIC_KEYS as readonly string[]).includes(key);
}
