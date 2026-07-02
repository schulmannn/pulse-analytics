import { describe, expect, it } from 'vitest';
import { fmt, ruAxisLabel, ruSeriesName, sparkAreaPath, sparkPath } from '@/lib/format';

describe('fmt', () => {
  it('formats grouped numbers and invalid values', () => {
    expect(fmt.num(1_234_567)).toBe(Math.round(1_234_567).toLocaleString('ru-RU').replace(/,/g, ' '));
    expect(fmt.num(12.6)).toBe('13');
    expect(fmt.num(null)).toBe('—');
    expect(fmt.num(Number.NaN)).toBe('—');
  });

  it('formats compact thousands and millions without trailing .0', () => {
    expect(fmt.short(1_000)).toBe('1k');
    expect(fmt.short(1_250)).toBe('1.3k');
    expect(fmt.short(2_000_000)).toBe('2M');
    expect(fmt.short(-3_400_000)).toBe('-3.4M');
    expect(fmt.short(null)).toBe('—');
  });

  it('formats signed percentages with configurable precision', () => {
    expect(fmt.pct(12.345)).toBe('+12.35%');
    expect(fmt.pct(-2.5, 1)).toBe('-2.5%');
    expect(fmt.pct(0, 0)).toBe('+0%');
    expect(fmt.pct(Number.NaN)).toBe('—');
  });
});

describe('ruAxisLabel', () => {
  it('translates English month tokens preserving the rest of the string', () => {
    expect(ruAxisLabel('24 Jun 21:00')).toBe('24 июн 21:00');
    expect(ruAxisLabel('18 May')).toBe('18 мая');
    expect(ruAxisLabel('22 Mar')).toBe('22 мар');
  });

  it('covers all 12 months', () => {
    const en = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const ru = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
    en.forEach((m, i) => expect(ruAxisLabel(`5 ${m}`)).toBe(`5 ${ru[i]}`));
  });

  it('passes through non-month and already-Russian labels unchanged', () => {
    expect(ruAxisLabel('05.06')).toBe('05.06');
    expect(ruAxisLabel('5 июн')).toBe('5 июн');
    expect(ruAxisLabel('')).toBe('');
    // Only whole tokens are translated — substrings inside words stay intact.
    expect(ruAxisLabel('Mayday')).toBe('Mayday');
  });
});

describe('ruSeriesName', () => {
  it('maps API-provided English series names to Russian', () => {
    expect(ruSeriesName('Views')).toBe('Просмотры');
    expect(ruSeriesName('Shares')).toBe('Репосты');
    expect(ruSeriesName('Followers')).toBe('Подписчики');
    expect(ruSeriesName('joined')).toBe('Подписались');
  });

  it('falls back to the original for unknown names and empty input', () => {
    expect(ruSeriesName('Story views')).toBe('Story views');
    expect(ruSeriesName('Просмотры')).toBe('Просмотры');
    expect(ruSeriesName(null)).toBe('');
    expect(ruSeriesName('  ')).toBe('');
  });
});

describe('spark paths', () => {
  it('creates one SVG command per value', () => {
    const path = sparkPath([0, 10, 5]);
    expect(path).toBe('M2.0,30.0 L100.0,2.0 L198.0,16.0');
    expect(path.split(' ')).toHaveLength(3);
    expect(sparkPath([])).toBe('');
  });

  it('closes the area path at the bottom corners', () => {
    const area = sparkAreaPath([0, 10, 5]);
    expect(area.startsWith('M2.0,30.0')).toBe(true);
    expect(area.endsWith('L200,32 L0,32 Z')).toBe(true);
    expect(sparkAreaPath([])).toBe('');
  });
});
