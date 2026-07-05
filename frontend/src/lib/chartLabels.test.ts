import { describe, expect, it } from 'vitest';
import { axisLabelBudget, axisLabelIndexes } from '@/lib/chartLabels';

describe('axisLabelBudget', () => {
  it('scales label capacity by measured width with a readable floor and cap', () => {
    expect(axisLabelBudget(120)).toBe(2);
    expect(axisLabelBudget(320, { minLabelPx: 80 })).toBe(4);
    expect(axisLabelBudget(1600, { minLabelPx: 80, maxLabels: 12 })).toBe(12);
  });

  it('stays safe for invalid widths', () => {
    expect(axisLabelBudget(Number.NaN)).toBe(2);
    expect(axisLabelBudget(-100)).toBe(2);
  });
});

describe('axisLabelIndexes', () => {
  it('keeps first and last labels while hiding dense middle ticks', () => {
    expect(axisLabelIndexes(30, 260, { minLabelPx: 80, maxLabels: 10 })).toEqual([0, 15, 29]);
  });

  it('shows more labels when the chart is wider, as in the detail view', () => {
    const compact = axisLabelIndexes(30, 260, { minLabelPx: 80, maxLabels: 12 });
    const detail = axisLabelIndexes(30, 920, { minLabelPx: 80, maxLabels: 12 });

    expect(detail.length).toBeGreaterThan(compact.length);
    expect(compact[0]).toBe(0);
    expect(compact.at(-1)).toBe(29);
    expect(detail[0]).toBe(0);
    expect(detail.at(-1)).toBe(29);
  });

  it('drops a near-last neighbour instead of stacking it next to the final label', () => {
    expect(axisLabelIndexes(14, 420, { minLabelPx: 80, maxLabels: 10 })).toEqual([0, 4, 8, 13]);
  });

  it('returns every index when the series already fits', () => {
    expect(axisLabelIndexes(4, 600)).toEqual([0, 1, 2, 3]);
  });
});
