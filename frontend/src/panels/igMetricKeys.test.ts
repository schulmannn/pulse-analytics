import { describe, expect, it } from 'vitest';
import { isIgChartMetricKey, IG_CHART_METRIC_KEYS } from './igMetricKeys';
import { routeNetworkOwner } from '@/lib/networks';

describe('Instagram chart-card metric route registry', () => {
  it('covers exactly the IG chart cards migrated off the generic overlay', () => {
    expect(IG_CHART_METRIC_KEYS).toEqual([
      'ig-age',
      'ig-gender',
      'ig-countries',
      'ig-cities',
      'ig-best-time',
      'ig-format-engagement',
      'ig-reels-watch-time',
      'ig-story-navigation',
    ]);
    expect(IG_CHART_METRIC_KEYS).toHaveLength(8);
    // Every key is unique (no accidental duplicate route).
    expect(new Set(IG_CHART_METRIC_KEYS).size).toBe(IG_CHART_METRIC_KEYS.length);
  });

  it('accepts its own keys and rejects other families / numeric IG drill keys', () => {
    for (const key of IG_CHART_METRIC_KEYS) expect(isIgChartMetricKey(key)).toBe(true);
    // The numeric daily/aggregate/ER IG keys stay owned by IgMetricPage's own DEFS, not this registry.
    for (const key of ['ig-reach', 'ig-views', 'ig-er', 'views', 'ym-visits', 'tg-heatmap', 'ms-revenue', 'ig', 'ig-unknown', undefined]) {
      expect(isIgChartMetricKey(key)).toBe(false);
    }
  });

  it('every registry route resolves to the Instagram network (routeNetworkOwner ig- branch)', () => {
    for (const key of IG_CHART_METRIC_KEYS) {
      expect(routeNetworkOwner(`/metrics/${key}`)).toBe('ig');
    }
  });
});
