import { describe, expect, it } from 'vitest';
import { changeLabel, fmtChangeValue } from './MsTopProducts';

const mover = (over: Partial<{ name: string; current: number; previous: number; delta: number; deltaPct: number | null }> = {}) => ({
  name: 'Товар',
  current: 0,
  previous: 0,
  delta: 0,
  deltaPct: null,
  ...over,
});

describe('MoySklad assortment dynamics presentation', () => {
  it('formats value in the metric natural unit', () => {
    expect(fmtChangeValue(1000, 'rub')).toBe('1k ₽');
    expect(fmtChangeValue(600, 'rub')).toBe('600 ₽');
    expect(fmtChangeValue(6, 'count')).toBe('6 шт.');
  });

  it('shows percent for gainers/losers when the previous base is non-zero', () => {
    expect(changeLabel(mover({ current: 1000, previous: 400, delta: 600, deltaPct: 150 }), 'gain', 'rub')).toBe('▲ 150.0%');
    expect(changeLabel(mover({ current: 200, previous: 900, delta: -700, deltaPct: -77.8 }), 'loss', 'rub')).toBe('▼ 77.8%');
  });

  it('falls back to the absolute shift when percent is unavailable (previous base was zero)', () => {
    // deltaPct === null must never be rendered as a fabricated ±100%.
    expect(changeLabel(mover({ current: 500, previous: 0, delta: 500, deltaPct: null }), 'gain', 'rub')).toBe('▲ 500 ₽');
    expect(changeLabel(mover({ current: 4, previous: 0, delta: 4, deltaPct: null }), 'gain', 'count')).toBe('▲ 4 шт.');
    expect(changeLabel(mover({ current: 500, previous: -200, delta: 700, deltaPct: null }), 'gain', 'rub')).toBe('▲ 700 ₽');
  });

  it('labels presence-only buckets honestly, not as added/removed catalog items', () => {
    expect(changeLabel(mover({ current: 800 }), 'appeared', 'rub')).toBe('ранее продаж не было');
    expect(changeLabel(mover({ previous: 700 }), 'disappeared', 'rub')).toBe('сейчас продаж нет');
  });
});
