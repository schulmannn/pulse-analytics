import { describe, expect, it } from 'vitest';
import { cumulativeFollowers, cityName, countryName } from '@/lib/igMetrics';

describe('cumulativeFollowers', () => {
  it('reconstructs the running total from daily net-new, anchored at the current total', () => {
    const series = [
      { day: '2026-06-01', value: 10 },
      { day: '2026-06-02', value: 5 },
      { day: '2026-06-03', value: -3 },
    ];
    const out = cumulativeFollowers(series, 100);
    // end-of-day totals: …→98 (+5)→103 (−3)→100. Most recent point == the current total.
    expect(out.map((p) => p.value)).toEqual([98, 103, 100]);
    expect(out[out.length - 1].value).toBe(100);
  });

  it('returns empty without a usable total or series', () => {
    expect(cumulativeFollowers([], 100)).toEqual([]);
    expect(cumulativeFollowers([{ day: '2026-06-01', value: 5 }], 0)).toEqual([]);
  });

  it('ignores the synthetic "total" point', () => {
    const out = cumulativeFollowers([{ day: 'total', value: 999 }, { day: '2026-06-02', value: 5 }], 50);
    expect(out).toHaveLength(1);
    expect(out[0].value).toBe(50);
  });
});

describe('geo normalization', () => {
  it('cityName keeps the city and drops the region', () => {
    expect(cityName('London, England')).toBe('London');
    expect(cityName('Yekaterinburg, Sverdlovsk Oblast')).toBe('Yekaterinburg');
    expect(cityName('Москва, Москва')).toBe('Москва');
  });

  it('countryName resolves a code and passes non-codes through', () => {
    expect(countryName('US')).toBeTruthy();
    expect(countryName('Россия')).toBe('Россия');
  });
});
