import { describe, expect, it } from 'vitest';
import { freshness, latestHistoryDay } from './freshness';
import type { HistoryData } from '@/api/schemas';

const NOW = Date.parse('2026-06-29T09:00:00');

describe('latestHistoryDay', () => {
  it('returns the newest day regardless of row order', () => {
    const history = {
      rows: [{ day: '2026-06-20' }, { day: '2026-06-28' }, { day: '2026-06-25' }],
    } as HistoryData;
    expect(latestHistoryDay(history)).toBe('2026-06-28');
  });

  it('returns null for empty/missing history', () => {
    expect(latestHistoryDay(null)).toBe(null);
    expect(latestHistoryDay({ rows: [] } as unknown as HistoryData)).toBe(null);
  });
});

describe('freshness', () => {
  it('labels today / yesterday / older and flags stale at ≥2 days', () => {
    expect(freshness('2026-06-29', NOW)).toEqual({ label: 'обновлено сегодня', stale: false });
    expect(freshness('2026-06-28', NOW)).toEqual({ label: 'обновлено вчера', stale: false });
    expect(freshness('2026-06-25', NOW)).toEqual({ label: 'обновлено 4 дн. назад', stale: true });
  });

  it('returns null when there is no day', () => {
    expect(freshness(null, NOW)).toBe(null);
  });
});
