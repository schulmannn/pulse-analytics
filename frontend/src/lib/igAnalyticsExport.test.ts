import { describe, expect, it } from 'vitest';
import { buildIgAnalyticsRows, type ExportPair, type IgAnalyticsExportInput } from '@/lib/igAnalyticsExport';

const pair = (cur: number, prev: number, hasCur: boolean, hasPrev: boolean): ExportPair => ({ cur, prev, hasCur, hasPrev });
const nil: ExportPair = pair(0, 0, false, false);

const baseInput = (over: Partial<IgAnalyticsExportInput['pairs']> = {}): IgAnalyticsExportInput => ({
  source: 'acct',
  window: { since: new Date(2026, 5, 1).getTime(), until: new Date(2026, 5, 30, 23, 59, 59, 999).getTime() },
  pairs: {
    reach: nil,
    views: nil,
    ti: nil,
    likes: nil,
    saves: nil,
    comments: nil,
    shares: nil,
    ...over,
  },
  netMovement: nil,
  erReach: 0,
  erReachPrev: 0,
});

describe('buildIgAnalyticsRows', () => {
  it('emits aggregate rows only — never a daily date for aggregate-only metrics', () => {
    const rows = buildIgAnalyticsRows(baseInput({ reach: pair(1000, 800, true, true) }));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.date === undefined)).toBe(true);
    expect(rows.find((r) => r.scope === 'current')).toMatchObject({ from: '2026-06-01', to: '2026-06-30', value: 1000 });
    expect(rows.find((r) => r.scope === 'previous')).toMatchObject({ from: '2026-05-02', to: '2026-05-31', value: 800 });
  });

  it('omits the previous row when the previous window is not calculable', () => {
    const rows = buildIgAnalyticsRows(baseInput({ views: pair(500, 0, true, false) }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scope).toBe('current');
  });

  it('skips a metric entirely when it has no current value (no fabricated 0)', () => {
    const rows = buildIgAnalyticsRows(baseInput({ likes: nil }));
    expect(rows).toHaveLength(0);
  });

  it('keeps a real zero ER and gates it on available numerator/denominator pairs', () => {
    const withEr = buildIgAnalyticsRows({
      ...baseInput({ reach: pair(100, 80, true, true), ti: pair(0, 0, true, true) }),
      erReach: 0,
      erReachPrev: 0,
    });
    const er = withEr.filter((r) => r.metric === 'ER (охват)');
    expect(er.map((r) => [r.scope, r.from, r.to, r.value, r.unit])).toEqual([
      ['current', '2026-06-01', '2026-06-30', 0, '%'],
      ['previous', '2026-05-02', '2026-05-31', 0, '%'],
    ]);
    const noEr = buildIgAnalyticsRows({ ...baseInput(), erReach: 0, erReachPrev: 0 });
    expect(noEr.some((r) => r.metric === 'ER (охват)')).toBe(false);
  });

  it('keeps reach and views as distinct metrics', () => {
    const rows = buildIgAnalyticsRows(baseInput({ reach: pair(10, 0, true, false), views: pair(99, 0, true, false) }));
    const metrics = rows.map((r) => r.metric);
    expect(metrics).toContain('Охват');
    expect(metrics).toContain('Просмотры');
  });
});
