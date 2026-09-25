import { describe, expect, it } from 'vitest';
import { cdekGrid, densifyCdekDays } from '@/lib/cdekSeries';
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

describe('densifyCdekDays уважает грануляцию', () => {
  it('недельные корзины НЕ разбавляются днями', () => {
    // Регресс, который владелец увидел на 90 днях: дневная сетка поверх понедельников вставляла
    // между ними по шесть нулей, и график читался как «продажи раз в неделю».
    const weeks = ['2026-06-01', '2026-06-08', '2026-06-22'].map((day) => pt(day, 1000));
    const dense = densifyCdekDays(weeks, '2026-06-01', '2026-06-28', 'week');
    expect(dense.map((p) => p.day)).toEqual(['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22']);
    // Пропущенная неделя достроена нулём — но НИ ОДНОГО лишнего дня между корзинами.
    expect(dense.map((p) => p.revenue)).toEqual([1000, 1000, 0, 1000]);
  });

  it('месячные корзины идут первыми числами', () => {
    const months = ['2026-01-01', '2026-03-01'].map((day) => pt(day, 500));
    const dense = densifyCdekDays(months, '2026-01-01', '2026-04-15', 'month');
    expect(dense.map((p) => p.day)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']);
    expect(dense.map((p) => p.revenue)).toEqual([500, 0, 500, 0]);
  });

  it('сетка короче ответа — ряд отдаётся как есть, корзины не теряются', () => {
    const days = ['2026-06-01', '2026-06-02', '2026-06-03'].map((day) => pt(day, 100));
    expect(densifyCdekDays(days, '2026-06-01', '2026-06-01', 'day')).toEqual(days);
  });

  it('грануляция по умолчанию — дневная (прежнее поведение вызовов без grain)', () => {
    const dense = densifyCdekDays([pt('2026-06-01', 10)], '2026-06-01', '2026-06-03');
    expect(dense.map((p) => p.day)).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
  });
});

describe('cdekGrid: длина корзины и краевые', () => {
  it('дневная сетка — по одному дню, краевых нет', () => {
    const grid = cdekGrid('2026-06-01', '2026-06-03', 'day');
    expect(grid.map((b) => b.days)).toEqual([1, 1, 1]);
    expect(grid.some((b) => b.partial)).toBe(false);
  });

  it('окно 90 дней: первая и последняя недели НЕПОЛНЫЕ', () => {
    // 2026-06-03 — среда: первая неделя покрыта окном на 5 дней из 7.
    const grid = cdekGrid('2026-06-03', '2026-08-31', 'week');
    expect(grid[0].days).toBe(5);
    expect(grid[0].partial).toBe(true);
    // Последняя корзина — понедельник 31 августа, из неё в окне один день.
    expect(grid[grid.length - 1].days).toBe(1);
    expect(grid[grid.length - 1].partial).toBe(true);
    // Внутренние недели полные — их и сравнивают между собой.
    expect(grid.slice(1, -1).every((b) => b.days === 7 && !b.partial)).toBe(true);
  });

  it('месяцы знают свою длину, февраль не равен марту', () => {
    const grid = cdekGrid('2026-01-01', '2026-04-30', 'month');
    expect(grid.map((b) => b.days)).toEqual([31, 28, 31, 30]);
    expect(grid.every((b) => !b.partial)).toBe(true);
  });

  it('окно внутри одного месяца — корзина неполная', () => {
    const grid = cdekGrid('2026-03-10', '2026-03-20', 'month');
    expect(grid).toHaveLength(1);
    expect(grid[0]).toEqual({ key: '2026-03-01', days: 11, partial: true });
  });
});
