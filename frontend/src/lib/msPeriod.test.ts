import { describe, expect, it } from 'vitest';
import { msPeriod, msPeriodKey, msPeriodQuery } from './msPeriod';
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
