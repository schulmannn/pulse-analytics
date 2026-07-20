import { describe, expect, it } from 'vitest';
import { fmt, parseDayKey, ruAxisLabel, ruSeriesName, sparkAreaPath, sparkPath } from '@/lib/format';

describe('parseDayKey', () => {
  it('parses a bare day key as LOCAL midnight of that calendar date', () => {
    const d = parseDayKey('2026-06-30');
    expect(d).not.toBeNull();
    // TZ-independent by construction: local components must equal the key's digits,
    // whatever zone the test host runs in (new Date('2026-06-30') would give 29 June
    // local components anywhere west of UTC — the D6.5 minus-one-day bug).
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(5);
    expect(d!.getDate()).toBe(30);
    expect(d!.getHours()).toBe(0);
  });

  it('rejects anything that is not a bare YYYY-MM-DD', () => {
    expect(parseDayKey('2026-06-30T12:00:00Z')).toBeNull();
    expect(parseDayKey('30.06')).toBeNull();
    expect(parseDayKey('')).toBeNull();
  });
});

describe('fmt.day / fmt.date timezone semantics', () => {
  it('renders a day key as its own calendar date in every timezone', () => {
    expect(fmt.day('2026-06-30')).toBe('30 июн.');
    expect(fmt.day('2026-01-01')).toBe('1 янв.');
  });

  it('renders an instant (Date / epoch-ms) as the local day of that instant', () => {
    const instant = new Date(2026, 5, 30, 15, 0); // local 30 June, 15:00
    expect(fmt.day(instant)).toBe('30 июн.');
    expect(fmt.day(instant.getTime())).toBe('30 июн.');
  });

  it('is empty for nullish or unparseable input', () => {
    expect(fmt.day(null)).toBe('');
    expect(fmt.day('')).toBe('');
    expect(fmt.day('not-a-date')).toBe('');
  });

  it('fmt.date renders a bare day key without inventing a time of day', () => {
    expect(fmt.date('2026-06-30')).toBe('30 июн.');
  });

  it('fmt.date keeps date+time for real timestamps', () => {
    const local = new Date(2026, 5, 30, 14, 30); // local-clock instant → stable expectation
    expect(fmt.date(local.toISOString())).toBe('30 июн., 14:30');
  });
});

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

  it('formats headline KPIs: full under 10 000, compact from 10 000', () => {
    expect(fmt.kpi(4_749)).toBe(fmt.num(4_749));
    expect(fmt.kpi(9_999)).toBe(fmt.num(9_999));
    expect(fmt.kpi(10_000)).toBe('10k');
    expect(fmt.kpi(12_634)).toBe('12.6k');
    expect(fmt.kpi(-10_500)).toBe('-10.5k');
    expect(fmt.kpi(null)).toBe('—');
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
  it('draws a non-overshooting smooth cubic — one C segment per gap, exact endpoints', () => {
    // Horizontal control handles (midpoint x, endpoint y) keep every segment inside its pair's
    // value range: no Bezier control point ever sits above the higher point or below the lower.
    const path = sparkPath([0, 10, 5]);
    expect(path).toBe('M2.0,30.0 C51.0,30.0 51.0,2.0 100.0,2.0 C149.0,2.0 149.0,16.0 198.0,16.0');
    // One move + one cubic per adjacent pair (n − 1 cubics).
    expect(path.startsWith('M')).toBe(true);
    expect(path.match(/C/g)).toHaveLength(2);
    // Endpoints are exact: first/last drawn coordinate equals the point's own y (30.0 / 16.0).
    expect(path.startsWith('M2.0,30.0')).toBe(true);
    expect(path.endsWith('198.0,16.0')).toBe(true);
    // Every control-point y is one of the two adjacent point ys — never an overshoot value.
    const ys = [...path.matchAll(/,(-?\d+\.\d)/g)].map((m) => Number(m[1]));
    for (const y of ys) expect(y >= 2.0 && y <= 30.0).toBe(true);
    expect(sparkPath([])).toBe('');
  });

  it('closes the area path along the same smooth top, down to the baseline corners', () => {
    const area = sparkAreaPath([0, 10, 5]);
    // The fill top is the identical smooth stroke path; only the baseline close is appended.
    expect(area.startsWith(sparkPath([0, 10, 5]))).toBe(true);
    expect(area).toContain(' C');
    expect(area.endsWith('L200,32 L0,32 Z')).toBe(true);
    expect(sparkAreaPath([])).toBe('');
  });
});
