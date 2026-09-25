/**
 * Ключи полностраничных метрик Rusender — семья `rusender-*` за `/metrics/:key`. Тонкая обёртка над
 * lib/metricIndex.ts (U05): список живёт в лёгком индексе каталога без зависимостей, поэтому
 * диспетчер маршрута (MetricRoute) и `networks.routeNetworkOwner` узнают цель разворота, НЕ
 * подтягивая тяжёлый чанк самой страницы — он грузится лениво, только когда открылся
 * `rusender-*`-ключ.
 *
 * Набор — только НАСТОЯЩИЕ дневные ряды, у которых есть что развернуть на полный экран:
 *   • открытия и клики — события дня (единственный подлинный временной ряд источника);
 *   • размер базы и отписавшиеся — дневной снимок, то есть уровень.
 *
 * «Рассылок периода» здесь СОЗНАТЕЛЬНО нет: их итоги кумулятивные и по дням не раскладываются,
 * разворачивать нечего — полноэкранный график там пришлось бы выдумать.
 */
import { RUSENDER_METRIC_KEYS } from '@/lib/metricIndex';

export { RUSENDER_METRIC_KEYS };

export type RusenderMetricKey = (typeof RUSENDER_METRIC_KEYS)[number];

export function isRusenderMetricKey(key: string | undefined): key is RusenderMetricKey {
  return key != null && (RUSENDER_METRIC_KEYS as readonly string[]).includes(key);
}
