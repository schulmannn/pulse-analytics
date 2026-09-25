import { describe, expect, it } from 'vitest';
import {
  breakdownTotal,
  displayWithShare,
  formatShare,
  withShares,
} from '@/lib/breakdownShare';

describe('breakdownShare', () => {
  it('считает долю от суммы всех строк', () => {
    const items = withShares([{ value: 750 }, { value: 250 }]);
    expect(items.map((i) => i.share)).toEqual([0.75, 0.25]);
  });

  it('игнорирует отрицательные/нечисловые значения в знаменателе', () => {
    expect(breakdownTotal([{ value: 10 }, { value: -5 }, { value: Number.NaN }])).toBe(10);
  });

  it('оставляет строки без доли, когда сумма нулевая', () => {
    expect(withShares([{ value: 0 }, { value: 0 }]).map((i) => i.share)).toEqual([undefined, undefined]);
  });

  it('при срезе топ-N доли остаются от ПОЛНОЙ суммы (сумма видимых < 100%)', () => {
    // Языки/эмодзи режутся slice(0, 8) ПОСЛЕ простановки долей: хвост не исчезает из картины.
    const all = Array.from({ length: 12 }, (_, i) => ({ label: `l${i}`, value: 100 - i }));
    const shown = withShares(all).slice(0, 8);
    expect(shown).toHaveLength(8);
    // Полная сумма = 1134 (значения 100..89), первая строка = 100/1134.
    expect(shown[0]!.share).toBeCloseTo(100 / 1134, 12);
    const visible = shown.reduce((sum, i) => sum + (i.share ?? 0), 0);
    expect(visible).toBeLessThan(1);
    expect(visible).toBeGreaterThan(0.6);
    // Тот же список, посчитанный ПОСЛЕ среза, дал бы ровно 100% — это и есть враньё доли.
    const wrong = withShares(all.slice(0, 8)).reduce((sum, i) => sum + (i.share ?? 0), 0);
    expect(wrong).toBeCloseTo(1, 12);
  });

  it('уважает явный знаменатель', () => {
    expect(withShares([{ value: 25 }], 200)[0]!.share).toBe(0.125);
  });

  it('форматирует долю как легенда круговой — до одного знака, целые без «.0»', () => {
    expect(formatShare(0.5432)).toBe('54.3%');
    expect(formatShare(1)).toBe('100%');
    expect(formatShare(0.71)).toBe('71%');
    expect(formatShare(0.705)).toBe('70.5%');
    expect(formatShare(0.0004)).toBe('<0.1%');
    expect(formatShare(0)).toBe('0%');
  });

  it('склеивает значение с долей и не трогает строку без доли', () => {
    expect(displayWithShare('1 310', 0.5432)).toBe('1 310 · 54.3%');
    expect(displayWithShare('1 310')).toBe('1 310');
  });
});
