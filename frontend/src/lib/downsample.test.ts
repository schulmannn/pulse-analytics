import { describe, expect, it } from 'vitest';
import { lttbDownsample, pickIndexes } from '@/lib/downsample';
import { pickIndexes as msPickIndexes, strideEvery } from '@/lib/msSeries';

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

describe('pickIndexes — равный шаг + последняя точка', () => {
  it('короткий ряд отдаёт все индексы по порядку', () => {
    expect(pickIndexes(4, 10)).toEqual([0, 1, 2, 3]);
    expect(pickIndexes(0, 10)).toEqual([]);
  });

  it('длинный ряд: шаг ceil(n/max), последняя точка всегда в выборке', () => {
    expect(pickIndexes(10, 4)).toEqual([0, 3, 6, 9]);
    expect(pickIndexes(11, 4)).toEqual([0, 3, 6, 9, 10]);
  });

  it('та же схема, что у strideEvery (X линий совпадает), и тот же экспорт из msSeries', () => {
    const rows = Array.from({ length: 37 }, (_, i) => i * 10);
    expect(pickIndexes(rows.length, 8).map((i) => rows[i])).toEqual(strideEvery(rows, 8));
    expect(msPickIndexes).toBe(pickIndexes);
  });
});
