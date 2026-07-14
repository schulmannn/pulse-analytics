import { describe, expect, it } from 'vitest';
import {
  MEDIAN_MIN_SAMPLE,
  compareToMedian,
  median,
  medianDeltaLabel,
  periodMedian,
} from '@/lib/postMedian';

describe('median', () => {
  it('returns the middle value for odd samples', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('averages the two middle values for even samples', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('drops non-finite values and returns null for an empty sample', () => {
    expect(median([Number.NaN, 5, Infinity, 1])).toBe(3);
    expect(median([])).toBeNull();
    expect(median([Number.NaN])).toBeNull();
  });
});

describe('periodMedian', () => {
  it('is withheld below the minimum sample size', () => {
    const few = Array.from({ length: MEDIAN_MIN_SAMPLE - 1 }, (_, i) => i + 1);
    expect(periodMedian(few)).toBeNull();
  });

  it('returns the median once the sample is large enough', () => {
    expect(periodMedian([10, 20, 30, 40, 50])).toBe(30);
  });

  it('returns null when the median is not positive (percent comparison meaningless)', () => {
    expect(periodMedian([0, 0, 0, 0, 0])).toBeNull();
  });
});

describe('compareToMedian', () => {
  it('reports a signed percent and direction above the median', () => {
    const cmp = compareToMedian(142, 100);
    expect(cmp?.pct).toBeCloseTo(42);
    expect(cmp?.dir).toBe('above');
    expect(cmp?.ratio).toBeCloseTo(1.42);
  });

  it('reports below the median with a negative percent', () => {
    const cmp = compareToMedian(82, 100);
    expect(cmp?.dir).toBe('below');
    expect(cmp?.pct).toBeCloseTo(-18);
  });

  it('treats a near-median value as "at"', () => {
    expect(compareToMedian(100.2, 100)?.dir).toBe('at');
  });

  it('withholds the comparison when the median is missing or non-positive', () => {
    expect(compareToMedian(100, null)).toBeNull();
    expect(compareToMedian(100, 0)).toBeNull();
    expect(compareToMedian(null, 100)).toBeNull();
    expect(compareToMedian(Number.NaN, 100)).toBeNull();
  });
});

describe('medianDeltaLabel', () => {
  it('renders an explicit signed label instead of relying on colour', () => {
    expect(medianDeltaLabel({ pct: 42, dir: 'above', ratio: 1.42 })).toBe('+42% к медиане');
    expect(medianDeltaLabel({ pct: -18, dir: 'below', ratio: 0.82 })).toBe('−18% к медиане');
  });

  it('uses a plain phrase at the median', () => {
    expect(medianDeltaLabel({ pct: 0.1, dir: 'at', ratio: 1.001 })).toBe('на уровне медианы');
  });
});
