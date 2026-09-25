import { describe, expect, it } from 'vitest';
import { routeNetworkOwner } from '@/lib/networks';
import {
  isMentionsMetricKey,
  MENTIONS_METRIC_KEYS,
} from '@/panels/mentions/mentionsMetricKeys';

describe('mentions full-screen metric registry', () => {
  it('contains the two chart routes exactly once', () => {
    expect(MENTIONS_METRIC_KEYS).toEqual([
      'mentions-timeline',
      'mentions-sources',
    ]);
    expect(new Set(MENTIONS_METRIC_KEYS).size).toBe(MENTIONS_METRIC_KEYS.length);
  });

  it('accepts only mentions chart routes', () => {
    for (const key of MENTIONS_METRIC_KEYS) {
      expect(isMentionsMetricKey(key)).toBe(true);
      expect(routeNetworkOwner(`/metrics/${key}`)).toBe('tg');
    }
    for (const key of ['mentions', 'views', 'tg-heatmap', 'ig-age', undefined]) {
      expect(isMentionsMetricKey(key)).toBe(false);
    }
  });
});
