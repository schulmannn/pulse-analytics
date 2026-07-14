import { describe, expect, it } from 'vitest';
import { describeChange, explainChange } from '@/lib/whyChanged';

const now = Date.parse('2026-06-15T00:00:00.000Z');

/** Zero-padded UTC day-key in June 2026, e.g. iso(8) → '2026-06-08'. */
const iso = (d: number): string => `2026-06-${String(d).padStart(2, '0')}`;

/** 7 days for the previous window (06-01..06-07) then 7 for the current (06-08..06-14). */
function series(prev: number[], cur: number[]): { day: string; v: number }[] {
  const rows: { day: string; v: number }[] = [];
  prev.forEach((v, i) => rows.push({ day: iso(i + 1), v }));
  cur.forEach((v, i) => rows.push({ day: iso(i + 8), v }));
  return rows;
}

describe('explainChange', () => {
  it('flags insufficient data when the previous window predates the collected archive', () => {
    // Archive starts 06-06, so the previous window (06-01..06-07) is mostly UNKNOWN, not silent:
    // filling those days as zero would fabricate a drop, so the comparison is withheld instead.
    const rows = [
      { day: iso(6), v: 10 },
      { day: iso(7), v: 10 },
      ...[8, 9, 10, 11, 12, 13, 14].map((d) => ({ day: iso(d), v: 10 })),
    ];
    const r = explainChange(rows, 7, now);
    expect(r.insufficient).toBe(true);
    expect(r.drivers).toEqual([]);
  });

  it('detects quiet days for a channel that does not post daily (sparse current window)', () => {
    // Previous window posts every day (7×20), the current one only three days (06-08/11/14). The
    // missing current days are real silence within coverage → filled as 0 → quiet-days surfaces.
    const prev = [1, 2, 3, 4, 5, 6, 7].map((d) => ({ day: iso(d), v: 20 }));
    const cur = [8, 11, 14].map((d) => ({ day: iso(d), v: 20 }));
    const r = explainChange([...prev, ...cur], 7, now);
    expect(r.insufficient).toBe(false);
    expect(r.direction).toBe('down');
    expect(r.current).toBe(60);
    expect(r.previous).toBe(140);
    const quiet = r.drivers.find((d) => d.kind === 'quiet-days');
    expect(quiet).toBeTruthy();
    expect(quiet?.detail.current).toBe(4);
    expect(quiet?.detail.previous).toBe(0);
  });

  it('buckets boundary-day posts into the correct window (UTC day edges)', () => {
    // currentStart = 06-08T00:00Z, previousStart = 06-01T00:00Z. Posts exactly on those edges and
    // at the last millisecond of the previous window must land in the expected window.
    const rows = [
      { day: '2026-06-01T00:00:00.000Z', v: 100 },
      { day: '2026-06-07T23:59:59.000Z', v: 10 },
      { day: '2026-06-08T00:00:00.000Z', v: 200 },
      { day: '2026-06-14T12:00:00.000Z', v: 10 },
    ];
    const r = explainChange(rows, 7, now);
    expect(r.insufficient).toBe(false);
    expect(r.current).toBe(210);
    expect(r.previous).toBe(110);
  });

  it('reports flat with no drivers below the meaningful threshold', () => {
    const r = explainChange(series([10, 10, 10, 10, 10, 10, 10], [10, 10, 10, 10, 10, 10, 10]), 7, now);
    expect(r.insufficient).toBe(false);
    expect(r.direction).toBe('flat');
    expect(r.drivers).toEqual([]);
  });

  it('attributes a drop to a single unmatched peak day as an OBSERVATION', () => {
    const r = explainChange(series([10, 10, 10, 10, 10, 10, 100], [10, 10, 10, 10, 10, 10, 10]), 7, now);
    expect(r.direction).toBe('down');
    expect(r.pct).toBeCloseTo(((70 - 160) / 160) * 100);
    const peak = r.drivers.find((d) => d.kind === 'peak-day');
    expect(peak).toBeTruthy();
    expect(peak?.certainty).toBe('observed');
    expect(peak?.detail.day).toBe('2026-06-07');
    expect(peak?.contribution).toBeLessThan(0);
    expect(peak?.share).toBeGreaterThan(0.25);
  });

  it('surfaces a change in publishing cadence (quiet days)', () => {
    const r = explainChange(series([10, 10, 10, 10, 10, 10, 10], [10, 10, 10, 0, 0, 0, 0]), 7, now);
    expect(r.direction).toBe('down');
    const quiet = r.drivers.find((d) => d.kind === 'quiet-days');
    expect(quiet).toBeTruthy();
    expect(quiet?.detail.current).toBe(4);
    expect(quiet?.detail.previous).toBe(0);
  });

  it('falls back to a broad shift when no single day dominates', () => {
    const r = explainChange(series([10, 10, 10, 10, 10, 10, 10], [20, 20, 20, 20, 20, 20, 20]), 7, now);
    expect(r.direction).toBe('up');
    expect(r.drivers.some((d) => d.kind === 'broad-shift')).toBe(true);
    expect(r.drivers.every((d) => d.certainty === 'observed')).toBe(true);
  });
});

describe('describeChange', () => {
  it('states insufficient data without evidence or a caveat', () => {
    const r = explainChange([{ day: '2026-06-10', v: 5 }], 7, now);
    const d = describeChange(r, 'Просмотры');
    expect(d.headline).toContain('недостаточно данных');
    expect(d.evidence).toEqual([]);
    expect(d.caveat).toBeNull();
  });

  it('frames drivers as observations with an explicit non-causal caveat', () => {
    const r = explainChange(series([10, 10, 10, 10, 10, 10, 100], [10, 10, 10, 10, 10, 10, 10]), 7, now);
    const d = describeChange(r, 'Просмотры');
    expect(d.headline).toContain('снижение');
    expect(d.evidence[0]).toContain('Основной вклад');
    expect(d.caveat).toBe('Это наблюдения по данным, а не установленные причины.');
    // Never asserts causation.
    expect(d.evidence.join(' ')).not.toMatch(/из-за|причина|потому что/i);
  });

  it('renders a grammatical, unsigned headline (no awkward "на +42%")', () => {
    const r = explainChange(series([10, 10, 10, 10, 10, 10, 10], [20, 20, 20, 20, 20, 20, 20]), 7, now);
    const d = describeChange(r, 'Просмотры');
    expect(r.direction).toBe('up');
    expect(d.headline).toBe('Просмотры: рост на 100% к прошлому периоду');
    expect(d.headline).not.toContain('+');
  });

  it('omits magnitude and caveat when flat', () => {
    const r = explainChange(series([10, 10, 10, 10, 10, 10, 10], [10, 10, 10, 10, 10, 10, 10]), 7, now);
    const d = describeChange(r, 'Просмотры');
    expect(d.headline).toContain('без заметных изменений');
    expect(d.caveat).toBeNull();
  });
});
