/**
 * Ключи полностраничных метрик СДЭКа — семья `cdek-*` за `/metrics/:key`. Тонкая обёртка над
 * lib/metricIndex.ts (U05): список живёт в лёгком индексе каталога без зависимостей, поэтому
 * диспетчер маршрута (MetricRoute) и `networks.routeNetworkOwner` узнают цель разворота, НЕ
 * подтягивая тяжёлый чанк самой страницы — он грузится лениво, только когда открылся `cdek-*`-ключ.
 *
 * Набор повторяет карточки «Обзора» и «Товаров» один-в-один: три дневных ряда продаж, два ряда
 * ассортимента и три разреза.
 */
import { CDEK_METRIC_KEYS } from '@/lib/metricIndex';

export { CDEK_METRIC_KEYS };

export type CdekMetricKey = (typeof CDEK_METRIC_KEYS)[number];

export function isCdekMetricKey(key: string | undefined): key is CdekMetricKey {
  return key != null && (CDEK_METRIC_KEYS as readonly string[]).includes(key);
}
