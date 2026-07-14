import { describe, expect, it } from 'vitest';
import { explorerChartHeight } from '@/lib/useExplorerChartHeight';

describe('explorerChartHeight', () => {
  it('gives the chart most of a desktop viewport', () => {
    expect(explorerChartHeight(900)).toBe(560);
    expect(explorerChartHeight(1200)).toBe(680);
  });

  it('keeps a readable floor and handles invalid input', () => {
    expect(explorerChartHeight(640)).toBe(420);
    expect(explorerChartHeight(Number.NaN)).toBe(560);
  });
});
