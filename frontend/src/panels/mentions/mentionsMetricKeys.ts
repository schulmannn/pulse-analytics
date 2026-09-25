/** Ключи разборов упоминаний `mentions-*` за `/metrics/:key`. Тонкая обёртка над lib/metricIndex.ts
 *  (U05): список живёт в лёгком индексе каталога, здесь — прежние имена экспорта. */
import { MENTIONS_METRIC_KEYS } from '@/lib/metricIndex';

export { MENTIONS_METRIC_KEYS };

export type MentionsMetricKey = (typeof MENTIONS_METRIC_KEYS)[number];

export function isMentionsMetricKey(key: string | undefined): key is MentionsMetricKey {
  return key != null && (MENTIONS_METRIC_KEYS as readonly string[]).includes(key);
}
