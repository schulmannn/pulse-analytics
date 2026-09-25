export const MENTIONS_METRIC_KEYS = [
  'mentions-timeline',
  'mentions-sources',
] as const;

export type MentionsMetricKey = (typeof MENTIONS_METRIC_KEYS)[number];

export function isMentionsMetricKey(key: string | undefined): key is MentionsMetricKey {
  return key != null && (MENTIONS_METRIC_KEYS as readonly string[]).includes(key);
}
