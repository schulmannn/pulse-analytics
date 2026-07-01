import { describe, it, expect } from 'vitest';
import { detectAnomalies } from './anomaly';

describe('detectAnomalies', () => {
  it('returns nothing for short series', () => {
    expect(detectAnomalies([1, 2, 3, 4])).toEqual([]);
  });

  it('flags a single sharp spike against a flat baseline', () => {
    const v = [10, 10, 11, 10, 9, 10, 80, 10, 11, 10, 9, 10];
    expect(detectAnomalies(v)).toContain(6);
  });

  it('flags a sharp drop', () => {
    const v = [50, 51, 49, 50, 52, 1, 50, 49, 51, 50];
    expect(detectAnomalies(v)).toContain(5);
  });

  it('does not flag a smooth monotonic climb (trend, not anomaly)', () => {
    const v = Array.from({ length: 30 }, (_, i) => 100 + i * 5);
    expect(detectAnomalies(v)).toEqual([]);
  });

  it('does not flag a flat series (zero variance)', () => {
    expect(detectAnomalies([7, 7, 7, 7, 7, 7, 7, 7])).toEqual([]);
  });

  it('respects a stricter k (fewer flags)', () => {
    const v = [10, 10, 11, 10, 9, 10, 30, 10, 11, 10, 9, 10];
    const loose = detectAnomalies(v, { k: 2 });
    const strict = detectAnomalies(v, { k: 6 });
    expect(loose.length).toBeGreaterThanOrEqual(strict.length);
  });
});
