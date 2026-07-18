import { describe, expect, it } from 'vitest';
import { cumulativeContribution, cumulativePointLabel } from './msConcentration';

describe('cumulativeContribution', () => {
  it('строит монотонную кумулятивную кривую по убыванию вклада', () => {
    const points = cumulativeContribution(
      [
        { name: 'A', value: 50 },
        { name: 'B', value: 30 },
        { name: 'C', value: 20 },
      ],
      100,
    );
    expect(points.map((p) => p.name)).toEqual(['A', 'B', 'C']);
    expect(points.map((p) => p.rank)).toEqual([1, 2, 3]);
    expect(points.map((p) => p.contributionPct)).toEqual([50, 30, 20]);
    expect(points.map((p) => p.cumulativePct)).toEqual([50, 80, 100]);
    // Кумулятив монотонно неубывающий.
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i].cumulativePct).toBeGreaterThanOrEqual(points[i - 1].cumulativePct);
    }
  });

  it('сортирует по вкладу, а не по исходному порядку', () => {
    const points = cumulativeContribution(
      [
        { name: 'small', value: 10 },
        { name: 'big', value: 90 },
      ],
      100,
    );
    expect(points.map((p) => p.name)).toEqual(['big', 'small']);
    expect(points[0].cumulativePct).toBe(90);
  });

  it('исключает отрицательные и нулевые вклады (не дают отрицательных/фейковых сегментов)', () => {
    const points = cumulativeContribution(
      [
        { name: 'pos', value: 40 },
        { name: 'zero', value: 0 },
        { name: 'loss', value: -25 },
      ],
      100,
    );
    expect(points.map((p) => p.name)).toEqual(['pos']);
    expect(points[0].cumulativePct).toBe(40);
  });

  it('знаменатель <= 0 или не число → пустая кривая (доля недоступна)', () => {
    const rows = [{ name: 'A', value: 10 }];
    expect(cumulativeContribution(rows, 0)).toEqual([]);
    expect(cumulativeContribution(rows, -5)).toEqual([]);
    expect(cumulativeContribution(rows, Number.NaN)).toEqual([]);
    expect(cumulativeContribution(rows, Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it('капит кумулятив на 100 при копеечных расхождениях округления', () => {
    // Сумма вкладов чуть больше знаменателя из-за округления рублей — кривая не рисует 100.x%.
    const points = cumulativeContribution(
      [
        { name: 'A', value: 60 },
        { name: 'B', value: 45 },
      ],
      100,
    );
    expect(points[1].cumulativePct).toBe(100);
    expect(points[0].cumulativePct).toBe(60);
  });

  it('ограничивает число точек параметром cap', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ name: `p${i}`, value: 40 - i }));
    const points = cumulativeContribution(rows, 1000, 10);
    expect(points).toHaveLength(10);
    expect(points[0].name).toBe('p0');
  });

  it('кумулятив не обязан дойти до 100, когда видимых строк меньше полного знаменателя', () => {
    // denominator (полный отчёт) больше суммы переданных строк → честно < 100%.
    const points = cumulativeContribution(
      [
        { name: 'A', value: 30 },
        { name: 'B', value: 20 },
      ],
      100,
    );
    expect(points[points.length - 1].cumulativePct).toBe(50);
  });
});

describe('cumulativePointLabel', () => {
  it('включает имя товара и проценты', () => {
    const label = cumulativePointLabel({ rank: 2, name: 'Кофе', contributionPct: 12.34, cumulativePct: 56.78 });
    expect(label).toContain('Кофе');
    expect(label).toContain('+12.3%');
    expect(label).toContain('56.8%');
  });

  it('подставляет запасное имя для пустой строки', () => {
    const label = cumulativePointLabel({ rank: 1, name: '', contributionPct: 5, cumulativePct: 5 });
    expect(label).toContain('Без названия');
  });
});
