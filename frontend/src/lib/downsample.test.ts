import { describe, expect, it } from 'vitest';
import { lttbDownsample } from '@/lib/downsample';

interface Point {
  x: number;
  y: number;
}

const valueOf = (point: Point) => point.y;

describe('lttbDownsample', () => {
  it('returns the original array when threshold is large enough or below three', () => {
    const rows = [
      { x: 0, y: 0 },
      { x: 1, y: 4 },
      { x: 2, y: 2 },
    ];
    expect(lttbDownsample(rows, rows.length, valueOf)).toBe(rows);
    expect(lttbDownsample(rows, 2, valueOf)).toBe(rows);
  });

  it('keeps endpoints and returns exactly the threshold count', () => {
    const rows = Array.from({ length: 100 }, (_, x) => ({
      x,
      y: Math.sin(x / 5) * 20 + x / 3,
    }));
    const sampled = lttbDownsample(rows, 12, valueOf);

    expect(sampled).toHaveLength(12);
    expect(sampled[0]).toBe(rows[0]);
    expect(sampled.at(-1)).toBe(rows.at(-1));
    sampled.forEach((point) => expect(rows).toContain(point));
  });
});
