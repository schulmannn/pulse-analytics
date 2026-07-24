import { describe, expect, it } from 'vitest';
import { isYmMetricKey, YM_METRIC_KEYS } from './ymMetricKeys';

describe('Яндекс.Метрика metric route registry', () => {
  it('covers every drillable card from Обзор /metrika (3 series + hourly + 14 breakdowns)', () => {
    expect(YM_METRIC_KEYS).toEqual([
      'ym-visits',
      'ym-users',
      'ym-pageviews',
      'ym-hourly',
      'ym-sources',
      'ym-referrers',
      'ym-social',
      'ym-messengers',
      'ym-devices',
      'ym-countries',
      'ym-cities',
      'ym-age',
      'ym-gender',
      'ym-goals',
      'ym-utm',
      'ym-pages',
      'ym-landings',
      'ym-exits',
    ]);
    expect(YM_METRIC_KEYS).toHaveLength(18);
  });

  it('rejects other metric families and unknown YM keys', () => {
    for (const key of YM_METRIC_KEYS) expect(isYmMetricKey(key)).toBe(true);
    for (const key of ['ig-reach', 'ms-revenue', 'views', 'ym-unknown', 'ym', undefined]) {
      expect(isYmMetricKey(key)).toBe(false);
    }
  });
});
