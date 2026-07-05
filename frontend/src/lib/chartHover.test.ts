import { describe, expect, it } from 'vitest';
import { columnIndex, nearestPointIndex } from '@/lib/chartHover';

describe('nearestPointIndex (point-anchored series, LineChart)', () => {
  // 5 points at origin=20, step=100 → x = 20, 120, 220, 320, 420.
  const n = 5;
  const origin = 20;
  const step = 100;

  it('snaps to the nearest point, boundaries halfway between points', () => {
    expect(nearestPointIndex(20, n, origin, step)).toBe(0);
    expect(nearestPointIndex(69, n, origin, step)).toBe(0); // just left of the 0/1 midpoint
    expect(nearestPointIndex(71, n, origin, step)).toBe(1); // just right of it
    expect(nearestPointIndex(240, n, origin, step)).toBe(2);
    expect(nearestPointIndex(420, n, origin, step)).toBe(4);
  });

  it('clamps the gutter and the right pad to the edge points (old edge-rect behaviour)', () => {
    expect(nearestPointIndex(0, n, origin, step)).toBe(0); // y-label gutter
    expect(nearestPointIndex(-50, n, origin, step)).toBe(0);
    expect(nearestPointIndex(999, n, origin, step)).toBe(4); // right pad
  });

  it('degenerate inputs stay safe', () => {
    expect(nearestPointIndex(123, 1, origin, step)).toBe(0);
    expect(nearestPointIndex(123, 0, origin, step)).toBe(0);
    expect(nearestPointIndex(123, n, origin, 0)).toBe(0); // zero step can't divide
    expect(nearestPointIndex(123, n, origin, Number.NaN)).toBe(0);
  });
});

describe('columnIndex (column-tiled charts, BarChart/DivergingBars)', () => {
  // 4 columns of width 50 starting at origin=30 → [30,80) [80,130) [130,180) [180,230).
  const n = 4;
  const origin = 30;
  const col = 50;

  it('floor semantics: a column owns [start, start+width)', () => {
    expect(columnIndex(30, n, origin, col)).toBe(0);
    expect(columnIndex(79.9, n, origin, col)).toBe(0);
    expect(columnIndex(80, n, origin, col)).toBe(1);
    expect(columnIndex(229, n, origin, col)).toBe(3);
  });

  it('clamps the centered-group side margins to the edge columns', () => {
    expect(columnIndex(0, n, origin, col)).toBe(0); // left margin
    expect(columnIndex(500, n, origin, col)).toBe(3); // right margin
  });

  it('degenerate inputs stay safe', () => {
    expect(columnIndex(10, 1, 0, 50)).toBe(0);
    expect(columnIndex(10, 0, 0, 50)).toBe(0);
    expect(columnIndex(10, n, origin, 0)).toBe(0);
    expect(columnIndex(10, n, origin, Number.NaN)).toBe(0);
  });
});
