import { describe, expect, it } from 'vitest';
import { isTgExtraMetricKey, TG_EXTRA_METRIC_KEYS } from './tgMetricKeys';
import { routeNetworkOwner } from '@/lib/networks';

describe('Telegram extra-chart metric route registry', () => {
  it('covers exactly the non-DrillKey chart cards migrated off the generic overlay', () => {
    expect(TG_EXTRA_METRIC_KEYS).toEqual([
      'tg-heatmap',
      'tg-velocity',
      'tg-weekday-reach',
      'tg-weekday-views',
      'tg-post-count',
      'tg-hours',
      'tg-format-views',
      'tg-hashtag-erv',
      'tg-emoji',
      'tg-engagement-mix',
      'tg-reach-by-type',
      'tg-erv-by-format',
      'tg-views-by-source',
      'tg-followers-by-source',
      'tg-languages',
      'tg-sentiment',
      'tg-churn',
    ]);
    expect(TG_EXTRA_METRIC_KEYS).toHaveLength(17);
    // Every key is unique (no accidental duplicate route).
    expect(new Set(TG_EXTRA_METRIC_KEYS).size).toBe(TG_EXTRA_METRIC_KEYS.length);
  });

  it('accepts its own keys and rejects other families / numeric TG drill keys', () => {
    for (const key of TG_EXTRA_METRIC_KEYS) expect(isTgExtraMetricKey(key)).toBe(true);
    // Numeric TG drill keys stay owned by MetricPage/kpiDerive, not this registry.
    for (const key of ['views', 'subscribers', 'er', 'ig-reach', 'ms-revenue', 'ym-visits', 'tg', 'tg-unknown', undefined]) {
      expect(isTgExtraMetricKey(key)).toBe(false);
    }
  });

  it('every registry route resolves to the Telegram network (routeNetworkOwner default branch)', () => {
    for (const key of TG_EXTRA_METRIC_KEYS) {
      expect(routeNetworkOwner(`/metrics/${key}`)).toBe('tg');
    }
  });
});
