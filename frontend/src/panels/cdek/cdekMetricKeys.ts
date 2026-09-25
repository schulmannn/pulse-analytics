/**
 * Ключи полностраничных метрик СДЭКа — семья `cdek-*` за `/metrics/:key`. Отдельный крошечный
 * модуль без зависимостей: диспетчер маршрута (MetricRoute) и `networks.routeNetworkOwner` обязаны
 * узнавать цель разворота, НЕ подтягивая тяжёлый чанк самой страницы — он грузится лениво, только
 * когда открылся `cdek-*`-ключ.
 *
 * Набор повторяет карточки «Обзора» и «Товаров» один-в-один: три дневных ряда продаж, два ряда
 * ассортимента и три разреза.
 */
export const CDEK_METRIC_KEYS = [
  // Дневные ряды: Линия/Столбцы + сравнение с равным предыдущим окном.
  'cdek-revenue',
  'cdek-orders',
  'cdek-aov',
  'cdek-units',
  'cdek-price',
  // Разрезы: полный список без выдуманного графика.
  'cdek-channels',
  'cdek-statuses',
  'cdek-products',
] as const;

export type CdekMetricKey = (typeof CDEK_METRIC_KEYS)[number];

export function isCdekMetricKey(key: string | undefined): key is CdekMetricKey {
  return key != null && (CDEK_METRIC_KEYS as readonly string[]).includes(key);
}
