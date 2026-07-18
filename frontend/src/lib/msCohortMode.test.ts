import { describe, expect, it } from 'vitest';
import { MS_COHORT_MODES, cohortCellValue, isMoneyCohortMode, type MsCohortCell } from './msCohortMode';

// Одна когорта из 10 исходных клиентов: offset0 все активны на 1000₽, offset1 половина на 400₽,
// offset2 — прошедший месяц БЕЗ заказов (active 0, revenue 0). Всё нормируется на size=10.
const cells: MsCohortCell[] = [
  { offset: 0, active: 10, revenue: 1000 },
  { offset: 1, active: 5, revenue: 400 },
  { offset: 2, active: 0, revenue: 0 },
];

describe('cohortCellValue', () => {
  it('retention — доля активных от ИСХОДНОГО размера', () => {
    expect(cohortCellValue(cells, 10, 0, 'retention')).toBe(1);
    expect(cohortCellValue(cells, 10, 1, 'retention')).toBe(0.5);
    expect(cohortCellValue(cells, 10, 2, 'retention')).toBe(0);
  });

  it('revenue — выручка месяца на исходного клиента (не на активного)', () => {
    expect(cohortCellValue(cells, 10, 0, 'revenue')).toBe(100);
    expect(cohortCellValue(cells, 10, 1, 'revenue')).toBe(40);
    expect(cohortCellValue(cells, 10, 2, 'revenue')).toBe(0);
  });

  it('ltv — накопленная выручка 0..N на исходного клиента', () => {
    expect(cohortCellValue(cells, 10, 0, 'ltv')).toBe(100);
    expect(cohortCellValue(cells, 10, 1, 'ltv')).toBe(140);
    expect(cohortCellValue(cells, 10, 2, 'ltv')).toBe(140); // месяц без заказов ничего не добавляет
  });

  it('пустая когорта → null во всех режимах', () => {
    for (const mode of MS_COHORT_MODES) expect(cohortCellValue(cells, 0, 0, mode)).toBeNull();
  });

  it('честно отражает отрицательную выручку (корректировки), а не прячет её', () => {
    const withRefund: MsCohortCell[] = [
      { offset: 0, active: 4, revenue: 800 },
      { offset: 1, active: 2, revenue: -200 },
    ];
    expect(cohortCellValue(withRefund, 4, 1, 'revenue')).toBe(-50);
    expect(cohortCellValue(withRefund, 4, 1, 'ltv')).toBe(150); // 800-200=600 /4
  });

  it('отсутствующий offset берётся за 0 (плотная сетка, но месяц без заказов)', () => {
    expect(cohortCellValue(cells, 10, 5, 'retention')).toBe(0);
    expect(cohortCellValue(cells, 10, 5, 'ltv')).toBe(140);
  });

  it('небезопасная сумма остаётся отсутствующей и не превращается в ноль', () => {
    const unsafe: MsCohortCell[] = [
      { offset: 0, active: 10, revenue: 1000 },
      { offset: 1, active: 5, revenue: null },
      { offset: 2, active: 3, revenue: 300 },
    ];
    expect(cohortCellValue(unsafe, 10, 0, 'ltv')).toBe(100);
    expect(cohortCellValue(unsafe, 10, 1, 'revenue')).toBeNull();
    expect(cohortCellValue(unsafe, 10, 1, 'ltv')).toBeNull();
    expect(cohortCellValue(unsafe, 10, 2, 'ltv')).toBeNull();
  });
});

describe('isMoneyCohortMode', () => {
  it('деньги — revenue/ltv, доля — retention', () => {
    expect(isMoneyCohortMode('retention')).toBe(false);
    expect(isMoneyCohortMode('revenue')).toBe(true);
    expect(isMoneyCohortMode('ltv')).toBe(true);
  });
});
