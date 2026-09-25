/**
 * «Яндекс.Метрика» metric-route keys — the `ym-*` family behind `/metrics/:key`. Тонкая обёртка над
 * lib/metricIndex.ts (U05): список живёт в лёгком индексе каталога без зависимостей, поэтому
 * диспетчер маршрута (panels/MetricRoute) и networks.routeNetworkOwner узнают YM-цель, НЕ подтягивая
 * тяжёлый чанк YmMetricPage в TG/IG-бандл метрик: страница грузится лениво, только когда открылся
 * `ym-*`-ключ.
 *
 * The set mirrors Обзор /metrika one-for-one: three real day-series (visits/users/pageviews), the
 * hourly rhythm heatmap, and fourteen breakdown/list reports. Order follows the Обзор board.
 */
import { YM_METRIC_KEYS } from '@/lib/metricIndex';

export { YM_METRIC_KEYS };

export type YmMetricKey = (typeof YM_METRIC_KEYS)[number];

export function isYmMetricKey(key: string | undefined): key is YmMetricKey {
  return key != null && (YM_METRIC_KEYS as readonly string[]).includes(key);
}
