import { describe, expect, it } from 'vitest';
import { densifyCdekDays } from '@/lib/cdekSeries';
import type { CdekPoint } from '@/api/cdek';

const pt = (day: string, revenue: number, orders = 1): CdekPoint => ({ day, revenue, orders, items: orders });

describe('densifyCdekDays', () => {
  it('достраивает дни без продаж честными нулями', () => {
    const dense = densifyCdekDays([pt('2026-07-27', 1000), pt('2026-07-30', 2000)], '2026-07-27', '2026-07-31');
    expect(dense.map((p) => p.day)).toEqual(['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31']);
    expect(dense.map((p) => p.revenue)).toEqual([1000, 0, 0, 2000, 0]);
    expect(dense.map((p) => p.orders)).toEqual([1, 0, 0, 1, 0]);
  });

  it('оба окна получают ОДНУ длину — иначе призрак не встанет на столбцы', () => {
    // Ровно случай владельца: в текущем окне продаж меньше дней, чем в предыдущем.
    const cur = densifyCdekDays([pt('2026-07-27', 1000)], '2026-07-27', '2026-08-25');
    const prev = densifyCdekDays(
      Array.from({ length: 30 }, (_, i) => pt(`2026-06-${String(27 + i).padStart(2, '0')}`, 10)),
      '2026-06-27',
      '2026-07-26',
    );
    expect(cur).toHaveLength(30);
    expect(prev).toHaveLength(30);
    expect(cur.length).toBe(prev.length);
  });

  it('точки вне окна не попадают в сетку', () => {
    const dense = densifyCdekDays([pt('2026-07-20', 999), pt('2026-07-28', 500)], '2026-07-27', '2026-07-29');
    expect(dense.map((p) => p.revenue)).toEqual([0, 500, 0]);
  });

  it('без границ окна ряд возвращается как есть', () => {
    const src = [pt('2026-07-27', 1000)];
    expect(densifyCdekDays(src, null, '2026-07-29')).toEqual(src);
    expect(densifyCdekDays(src, '2026-07-27', undefined)).toEqual(src);
  });

  it('перевёрнутое или абсурдное окно не роняет расчёт и не строит миллион узлов', () => {
    const src = [pt('2026-07-27', 1000)];
    expect(densifyCdekDays(src, '2026-07-29', '2026-07-27')).toEqual(src);
    expect(densifyCdekDays(src, '2020-01-01', '2030-01-01')).toEqual(src);
  });

  it('день окна ровно один — сетка из одной точки', () => {
    expect(densifyCdekDays([], '2026-07-27', '2026-07-27')).toEqual([
      { day: '2026-07-27', revenue: 0, orders: 0, items: 0 },
    ]);
  });
});
