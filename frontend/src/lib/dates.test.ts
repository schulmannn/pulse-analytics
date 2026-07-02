import { describe, expect, it } from 'vitest';
import { compareDdMm, ddMmSortKey } from '@/lib/dates';

describe('ddMmSortKey', () => {
  it('keeps a same-year window in calendar order', () => {
    const now = new Date(2026, 5, 15); // 15 Jun 2026
    const labels = ['03.06', '01.06', '10.06', '28.05'];
    const sorted = [...labels].sort((a, b) => compareDdMm(a, b, now));
    expect(sorted).toEqual(['28.05', '01.06', '03.06', '10.06']);
  });

  it('sorts December before January across New Year (viewed in January)', () => {
    const now = new Date(2027, 0, 5); // 5 Jan 2027
    const labels = ['03.01', '28.12', '01.01', '30.12'];
    const sorted = [...labels].sort((a, b) => compareDdMm(a, b, now));
    expect(sorted).toEqual(['28.12', '30.12', '01.01', '03.01']);
  });

  it('assigns December labels to the previous year when viewed in January', () => {
    const now = new Date(2027, 0, 5);
    expect(new Date(ddMmSortKey('28.12', now)).getFullYear()).toBe(2026);
    expect(new Date(ddMmSortKey('03.01', now)).getFullYear()).toBe(2027);
  });

  it('keeps December labels in the current year when viewed in December', () => {
    const now = new Date(2026, 11, 20); // 20 Dec 2026
    expect(new Date(ddMmSortKey('01.12', now)).getFullYear()).toBe(2026);
    // June viewed from December is 6 months back — still the current year.
    expect(new Date(ddMmSortKey('15.06', now)).getFullYear()).toBe(2026);
  });

  it('treats a slightly-future label (timezone edge) as the current year, not next year', () => {
    const now = new Date(2026, 11, 31); // 31 Dec 2026, server may already stamp 01.01
    const key = ddMmSortKey('01.01', now);
    expect(new Date(key).getFullYear()).toBe(2026);
  });

  it('handles a full 14-day Dec→Jan window end to end', () => {
    const now = new Date(2027, 0, 8);
    const labels = ['26.12', '27.12', '28.12', '29.12', '30.12', '31.12', '01.01', '02.01', '03.01', '04.01', '05.01', '06.01', '07.01', '08.01'];
    const shuffled = [...labels].reverse();
    const sorted = shuffled.sort((a, b) => compareDdMm(a, b, now));
    expect(sorted).toEqual(labels);
  });
});
