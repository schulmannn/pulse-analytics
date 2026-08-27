import { describe, expect, it } from 'vitest';
import { clampTargetToDomain, MIN_SERIES_SHARE } from '@/lib/targetDomain';

describe('clampTargetToDomain', () => {
  it('нет цели — нет уровня', () => {
    expect(clampTargetToDomain(null, 0, 100)).toEqual({ value: null, clipped: false });
    expect(clampTargetToDomain(undefined, 0, 100)).toEqual({ value: null, clipped: false });
    expect(clampTargetToDomain(Number.NaN, 0, 100)).toEqual({ value: null, clipped: false });
  });

  it('цель внутри данных проходит нетронутой', () => {
    expect(clampTargetToDomain(50, 0, 100)).toEqual({ value: 50, clipped: false });
    // Ровно на максимуме — тоже не клип: домен уже её вмещает.
    expect(clampTargetToDomain(100, 0, 100)).toEqual({ value: 100, clipped: false });
  });

  it('умеренно высокая цель растягивает домен, но ряд остаётся читаемым', () => {
    // Случай владельца: данные 0…49 169, цель 60 000 — ряду остаётся 82%, клипать нечего.
    const r = clampTargetToDomain(60_000, 0, 49_169);
    expect(r).toEqual({ value: 60_000, clipped: false });
    expect(49_169 / 60_000).toBeGreaterThan(MIN_SERIES_SHARE);
  });

  it('недостижимая цель режется по окну и помечается', () => {
    // Те же данные и цель 200k: без потолка ряд получил бы 25% высоты.
    const r = clampTargetToDomain(200_000, 0, 49_169);
    expect(r.clipped).toBe(true);
    expect(r.value).toBeCloseTo(49_169 / MIN_SERIES_SHARE, 6);
    // Ряд занимает ровно оговорённую долю — не меньше.
    expect(49_169 / (r.value ?? 1)).toBeCloseTo(MIN_SERIES_SHARE, 6);
  });

  it('порог считается от РАЗМАХА, а не от нуля', () => {
    // Ряд 1000…1100 (размах 100): цель 1200 далеко от нуля, но по размаху — вдвое дальше потолка.
    const r = clampTargetToDomain(1200, 1000, 1100);
    expect(r.clipped).toBe(true);
    expect(r.value).toBeCloseTo(1000 + 100 / MIN_SERIES_SHARE, 6);
  });

  it('плоский ряд не сплющить — цель берётся как есть', () => {
    expect(clampTargetToDomain(60_000, 2000, 2000)).toEqual({ value: 60_000, clipped: false });
  });

  it('отрицательный размах невозможен, но вырожденный вход не роняет расчёт', () => {
    const r = clampTargetToDomain(10, 5, 5);
    expect(r).toEqual({ value: 10, clipped: false });
  });
});
