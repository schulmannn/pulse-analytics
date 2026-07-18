import { describe, expect, it } from 'vitest';
import { msPeriod, msPeriodBounds, msPeriodKey, msPeriodQuery, msPreviousPeriod } from './msPeriod';
import type { PagePeriodValue, PeriodDays } from './period';
import { endOfLocalDay, startOfLocalDay } from './period';

const pp = (over: Partial<PagePeriodValue>): PagePeriodValue => ({
  days: 30,
  setDays: () => {},
  range: null,
  setRange: () => {},
  ...over,
});

// Local noon so the local-calendar day-key is unambiguous regardless of the runner's timezone.
const NOW = new Date(2026, 6, 18, 12).getTime();

describe('msPeriod — page period → MS window', () => {
  it.each([
    [7, '2026-07-12', '2026-07-18'],
    [30, '2026-06-19', '2026-07-18'],
    [90, '2026-04-20', '2026-07-18'],
  ])('pins a %i-day preset to explicit local calendar bounds', (days, from, to) => {
    const p = msPeriod(pp({ days: days as PeriodDays }), NOW);
    // days stays as the label/fallback; from/to are the exact inclusive window; not a custom range.
    expect(p).toEqual({ days, from, to });
    expect(p.custom).toBeUndefined();
    // Explicit bounds ride along on both the wire query and the cache key.
    expect(msPeriodQuery(p)).toBe(`days=${days}&from=${from}&to=${to}`);
    expect(msPeriodKey(p)).toEqual(['r', from, to]);
  });

  it('leaves «Всё» (days=0) unbounded — no from/to, no invented previous', () => {
    const p = msPeriod(pp({ days: 0 }), NOW);
    expect(p).toEqual({ days: 0 });
    expect(msPeriodQuery(p)).toBe('days=0');
    expect(msPeriodKey(p)).toEqual(['d', 0]);
    expect(msPeriodBounds(p, NOW)).toBeNull();
    expect(msPreviousPeriod(p, NOW)).toBeNull();
  });

  it('falls back to a bounded 30д window outside a feed (null page period)', () => {
    expect(msPeriod(null, NOW)).toEqual({ days: 30, from: '2026-06-19', to: '2026-07-18' });
  });

  it('honours an exact inclusive custom range and marks it custom', () => {
    const from = startOfLocalDay(new Date(2026, 2, 5).getTime());
    const to = endOfLocalDay(new Date(2026, 2, 18).getTime());
    const p = msPeriod(pp({ days: 30, range: { from, to } }), NOW);
    expect(p).toEqual({ days: 30, from: '2026-03-05', to: '2026-03-18', custom: true });
    // Both endpoints are sent so the backend can bound the window on both sides.
    expect(msPeriodQuery(p)).toBe('days=30&from=2026-03-05&to=2026-03-18');
    // A custom window keys distinctly from a same-labelled preset (different bounds).
    expect(msPeriodKey(p)).toEqual(['r', '2026-03-05', '2026-03-18']);
    expect(msPeriodKey(p)).not.toEqual(msPeriodKey(msPeriod(pp({ days: 30 }), NOW)));
  });

  it('keeps the key stable across renders within the same local day (no refetch loop)', () => {
    const morning = msPeriod(pp({ days: 7 }), new Date(2026, 6, 18, 6).getTime());
    const evening = msPeriod(pp({ days: 7 }), new Date(2026, 6, 18, 23).getTime());
    expect(msPeriodKey(morning)).toEqual(msPeriodKey(evening));
    expect(msPeriodQuery(morning)).toEqual(msPeriodQuery(evening));
  });
});

describe('msPeriod — leap-year and month/year boundary bounds', () => {
  it('spans a leap day when the preset ends on Feb 29', () => {
    const leapNow = new Date(2024, 1, 29, 12).getTime();
    const p = msPeriod(pp({ days: 7 }), leapNow);
    expect(p).toEqual({ days: 7, from: '2024-02-23', to: '2024-02-29' });
    expect(msPreviousPeriod(p, leapNow)).toEqual({ days: 7, from: '2024-02-16', to: '2024-02-22' });
  });

  it('crosses a year boundary for a 30д window starting in December', () => {
    const janNow = new Date(2026, 0, 5, 9).getTime();
    expect(msPeriod(pp({ days: 30 }), janNow)).toEqual({ days: 30, from: '2025-12-07', to: '2026-01-05' });
  });
});

describe('msPreviousPeriod — equal inclusive calendar windows', () => {
  it.each([
    [7, '2026-07-12', '2026-07-18', '2026-07-05', '2026-07-11'],
    [30, '2026-06-19', '2026-07-18', '2026-05-20', '2026-06-18'],
    [90, '2026-04-20', '2026-07-18', '2026-01-20', '2026-04-19'],
  ])('keeps a %i-day preset exact', (days, from, to, prevFrom, prevTo) => {
    const period = msPeriod(pp({ days: days as PeriodDays }), NOW);
    expect(msPeriodBounds(period, NOW)).toEqual({ from, to });
    expect(msPreviousPeriod(period, NOW)).toEqual({ days, from: prevFrom, to: prevTo });
  });

  it('shifts a custom range by its inclusive calendar-day count', () => {
    expect(msPreviousPeriod({ days: 30, from: '2026-03-05', to: '2026-03-18', custom: true }, NOW)).toEqual({
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
