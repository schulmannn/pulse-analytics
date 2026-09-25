/**
 * МойСклад metric-route keys — the `ms-*` family behind `/metrics/:key`. Тонкая обёртка над
 * lib/metricIndex.ts (U05): список живёт в лёгком индексе каталога без зависимостей, поэтому
 * диспетчер маршрута (panels/MetricRoute) и networks.routeNetworkOwner узнают MS-цель, НЕ подтягивая
 * тяжёлый чанк MsMetricPage в TG/IG-бандл метрик: страница грузится лениво, только когда открылся
 * `ms-*`-ключ.
 */
import { MS_METRIC_KEYS } from '@/lib/metricIndex';

export { MS_METRIC_KEYS };

export type MsMetricKey = (typeof MS_METRIC_KEYS)[number];

export function isMsMetricKey(key: string | undefined): key is MsMetricKey {
  return key != null && (MS_METRIC_KEYS as readonly string[]).includes(key);
}
