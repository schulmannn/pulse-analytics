import { describe, expect, it } from 'vitest';
import { analyticsRowsToCsvRows, exportFilename, slugify, toYmd, type AnalyticsRow } from '@/lib/analyticsExport';

describe('toYmd', () => {
  it('formats a local calendar day', () => {
    expect(toYmd(new Date(2026, 5, 3).getTime())).toBe('2026-06-03');
    expect(toYmd(new Date(2026, 11, 31).getTime())).toBe('2026-12-31');
  });
});

describe('slugify', () => {
  it('produces an ascii slug', () => {
    expect(slugify('My Channel!')).toBe('my-channel');
    expect(slugify('  spaced  out  ')).toBe('spaced-out');
  });
  it('keeps Unicode letters and removes unsafe separators', () => {
    expect(slugify('Мой / Канал')).toBe('мой-канал');
    expect(slugify(null)).toBe('');
  });
});

describe('exportFilename', () => {
  const from = new Date(2026, 5, 1).getTime();
  const to = new Date(2026, 5, 30).getTime();
  it('is deterministic with network, section, source and window', () => {
    expect(exportFilename({ network: 'telegram', section: 'analytics', source: 'My Chan', from, to })).toBe(
      'telegram-analytics-my-chan-2026-06-01_2026-06-30.csv',
    );
  });
  it('keeps a Unicode source and omits bounds when unknown', () => {
    expect(exportFilename({ network: 'instagram', section: 'content', source: 'Канал' })).toBe('instagram-content-канал.csv');
    expect(exportFilename({ network: 'instagram', section: 'content', from, to })).toBe(
      'instagram-content-2026-06-01_2026-06-30.csv',
    );
  });
});

describe('analyticsRowsToCsvRows', () => {
  it('projects to the fixed column order, filling absent date with empty', () => {
    const rows: AnalyticsRow[] = [
      { network: 'telegram', source: 's', section: 'Аналитика', scope: 'current', from: 'a', to: 'b', date: '2026-06-01', metric: 'Просмотры', value: 10, unit: 'просмотры' },
      { network: 'instagram', source: 's', section: 'Аналитика', scope: 'current', from: 'a', to: 'b', metric: 'Охват', value: 0, unit: 'охват' },
    ];
    const csv = analyticsRowsToCsvRows(rows);
    expect(Object.keys(csv[0] ?? {})).toEqual(['network', 'source', 'section', 'scope', 'from', 'to', 'date', 'metric', 'value', 'unit']);
    expect(csv[0]?.date).toBe('2026-06-01');
    expect(csv[1]?.date).toBe(''); // aggregate row → empty, never fabricated
    expect(csv[1]?.value).toBe(0); // a real 0 survives the ?? '' guard
  });
});
