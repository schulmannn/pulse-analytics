/**
 * Telegram «extra chart» metric-route keys — the `tg-*` family behind `/metrics/:key` for the
 * Analytics chart cards that were NOT part of the numeric KPI drill set (kpiDerive's DrillKey:
 * views/avgReach/reactions/forwards/er/subscribers → the steep MetricPage explorer). These chart
 * cards used to open the generic in-place `?detail=` overlay; they now each drill to a dedicated
 * full-screen route like every other chart card, matching /metrics/ig-* and /metrics/ym-*.
 *
 * Тонкая обёртка над lib/metricIndex.ts (U05): список ключей и всё, что известно о метриках,
 * живут в лёгком индексе каталога, а здесь остаются прежние имена экспорта. Индекс так же без
 * зависимостей, поэтому диспетчер маршрута (panels/MetricRoute) по-прежнему узнаёт `tg-*`, НЕ
 * подтягивая чанк TgMetricPage — страница грузится лениво, только когда открылся её ключ.
 * `routeNetworkOwner` already resolves any non-ig/ms/ym `/metrics/*` key to Telegram, so these need
 * no entry there.
 *
 * ЧЕСТНОСТЬ важнее паритета: heatmap/velocity keep their own shapes; the weekday/hour cards keep the
 * honest category Bar/Line the source card already offered; every categorical breakdown is a truthful
 * full-height rank list — none fabricates a time-series, a Line/Bar choice, or a previous-period
 * comparison the source card didn't have.
 *
 * NB: the numeric TG drill keys (views/avgReach/…/subscribers) are validated by kpiDerive.isDrillKey
 * inside MetricPage itself — this set is ONLY the non-DrillKey chart cards.
 */
import { TG_EXTRA_METRIC_KEYS } from '@/lib/metricIndex';

export { TG_EXTRA_METRIC_KEYS };

export type TgExtraMetricKey = (typeof TG_EXTRA_METRIC_KEYS)[number];

export function isTgExtraMetricKey(key: string | undefined): key is TgExtraMetricKey {
  return key != null && (TG_EXTRA_METRIC_KEYS as readonly string[]).includes(key);
}
