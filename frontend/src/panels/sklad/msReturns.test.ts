import { describe, expect, it } from 'vitest';
import { fmtReturnsMetric, returnsMetricTotal, RETURNS_METRIC_OPTIONS } from './MsOverview';

describe('returns metric helpers', () => {
  const series = [
    { day: '2026-07-01', count: 2, sum: 1400 },
    { day: '2026-07-04', count: 1, sum: 700 },
    { day: '2026-07-06', count: 0, sum: 0 },
  ];

  it('returnsMetricTotal sums the selected metric across days', () => {
    expect(returnsMetricTotal(series, 'count')).toBe(3);
    expect(returnsMetricTotal(series, 'sum')).toBe(2100);
    expect(returnsMetricTotal([], 'count')).toBe(0);
  });

  it('fmtReturnsMetric formats count as a plain number and sum in rubles; null → dash', () => {
    expect(fmtReturnsMetric('count', 3)).toBe('3');
    expect(fmtReturnsMetric('sum', 2100)).toMatch(/₽/);
    expect(fmtReturnsMetric('count', null)).toBe('—');
  });

  it('exposes exactly the count/sum segmented options', () => {
    expect(RETURNS_METRIC_OPTIONS.map((o) => o.value)).toEqual(['count', 'sum']);
  });
});
