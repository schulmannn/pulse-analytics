import { describe, expect, it } from 'vitest';
import { goalPct } from '@/lib/igGoals';

describe('goalPct', () => {
  it('computes percentage of target, clamped to 0–100', () => {
    expect(goalPct(50, 100)).toBe(50);
    expect(goalPct(150, 100)).toBe(100); // over target clamps
    expect(goalPct(0, 100)).toBe(0);
  });

  it('returns 0 for invalid/non-positive targets or current', () => {
    expect(goalPct(50, 0)).toBe(0);
    expect(goalPct(50, -10)).toBe(0);
    expect(goalPct(Number.NaN, 100)).toBe(0);
  });
});
