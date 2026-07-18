import { describe, expect, it } from 'vitest';
import { msPeriod, msPeriodBounds, msPeriodKey, msPeriodQuery, msPreviousPeriod } from './msPeriod';
import type { PagePeriodValue } from './period';
import { endOfLocalDay, startOfLocalDay } from './period';

const pp = (over: Partial<PagePeriodValue>): PagePeriodValue => ({
  days: 30,
  setDays: () => {},
  range: null,
  setRange: () => {},
  ...over,
});

describe('msPeriod — page period → MS window', () => {
  it('serialises a preset with just days', () => {
    const p = msPeriod(pp({ days: 90 }));
    expect(p).toEqual({ days: 90 });
    expect(msPeriodQuery(p)).toBe('days=90');
    expect(msPeriodKey(p)).toEqual(['d', 90]);
  });

  it('falls back to 30д outside a feed (null page period)', () => {
    expect(msPeriod(null)).toEqual({ days: 30 });
  });

  it('honours an exact inclusive custom range as local day keys', () => {
    const from = startOfLocalDay(new Date(2026, 2, 5).getTime());
    const to = endOfLocalDay(new Date(2026, 2, 18).getTime());
    const p = msPeriod(pp({ days: 30, range: { from, to } }));
    expect(p).toEqual({ days: 30, from: '2026-03-05', to: '2026-03-18' });
    // Both endpoints are sent so the backend can bound the window on both sides.
    expect(msPeriodQuery(p)).toBe('days=30&from=2026-03-05&to=2026-03-18');
    // A custom window keys distinctly from any preset, and two ranges stay distinct.
    expect(msPeriodKey(p)).toEqual(['r', '2026-03-05', '2026-03-18']);
    expect(msPeriodKey(p)).not.toEqual(msPeriodKey(msPeriod(pp({ days: 30 }))));
  });
});

describe('msPreviousPeriod — equal inclusive calendar windows', () => {
  const NOW = new Date(2026, 6, 18, 12).getTime();

  it.each([
    [7, '2026-07-12', '2026-07-18', '2026-07-05', '2026-07-11'],
    [30, '2026-06-19', '2026-07-18', '2026-05-20', '2026-06-18'],
    [90, '2026-04-20', '2026-07-18', '2026-01-20', '2026-04-19'],
  ])('keeps a %i-day preset exact', (days, from, to, prevFrom, prevTo) => {
    const period = { days };
    expect(msPeriodBounds(period, NOW)).toEqual({ from, to });
    expect(msPreviousPeriod(period, NOW)).toEqual({ days, from: prevFrom, to: prevTo });
  });

  it('shifts a custom range by its inclusive calendar-day count', () => {
    expect(msPreviousPeriod({ days: 30, from: '2026-03-05', to: '2026-03-18' }, NOW)).toEqual({
      days: 30,
      from: '2026-02-19',
      to: '2026-03-04',
    });
  });

  it('does not invent a predecessor for All', () => {
    expect(msPeriodBounds({ days: 0 }, NOW)).toBeNull();
    expect(msPreviousPeriod({ days: 0 }, NOW)).toBeNull();
  });
});
