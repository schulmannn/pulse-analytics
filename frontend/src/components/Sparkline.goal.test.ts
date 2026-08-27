import { describe, expect, it } from 'vitest';
import { clampTargetToDomain } from '@/lib/targetDomain';
import { sparkDomain } from '@/lib/robustDomain';

/**
 * Правило цели НА ИСКРЕ: достижимая расширяет окно просмотра, недостижимая не рисуется вовсе.
 * Линия без числа, стоящая не на своём уровне, врала бы про расстояние до цели — а подписать её
 * в 200×32 без осей нечем.
 */
describe('цель на компактной искре', () => {
  const values = Array.from({ length: 30 }, (_, i) => 2000 + (i % 5) * 100);

  it('достижимая цель расширяет окно и остаётся видимой', () => {
    const base = sparkDomain(values);
    const goal = clampTargetToDomain(2800, base.min, base.max);
    expect(goal.clipped).toBe(false);
    expect(goal.value).toBe(2800);
    // Окно поднимается до цели — иначе линия ушла бы за край.
    expect(Math.max(base.max, goal.value ?? 0)).toBe(2800);
  });

  it('недостижимая цель не рисуется: её уровень нечем подписать', () => {
    const base = sparkDomain(values);
    const goal = clampTargetToDomain(900_000, base.min, base.max);
    expect(goal.clipped).toBe(true);
  });

  it('цель внутри данных не трогает окно', () => {
    const base = sparkDomain(values);
    const goal = clampTargetToDomain(2100, base.min, base.max);
    expect(goal).toEqual({ value: 2100, clipped: false });
    expect(Math.max(base.max, goal.value ?? 0)).toBe(base.max);
  });
});
