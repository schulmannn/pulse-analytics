import { describe, expect, it } from 'vitest';
import { isMsMetricKey, MS_METRIC_KEYS } from './msMetricKeys';

describe('MoySklad metric route registry', () => {
  it('covers every expandable visualization from Overview, Clients and Channels', () => {
    expect(MS_METRIC_KEYS).toEqual([
      'ms-revenue',
      'ms-orders',
      'ms-aov',
      'ms-customers',
      'ms-repeat',
      'ms-rfm',
      'ms-channels',
      'ms-funnel',
      'ms-products',
      'ms-returns',
      'ms-sales-channels',
      'ms-geography',
      'ms-top-customers',
      'ms-cohorts',
    ]);
  });

  it('rejects other metric families and unknown MS keys', () => {
    for (const key of MS_METRIC_KEYS) expect(isMsMetricKey(key)).toBe(true);
    for (const key of ['ig-reach', 'views', 'ms-unknown', undefined]) expect(isMsMetricKey(key)).toBe(false);
  });
});
