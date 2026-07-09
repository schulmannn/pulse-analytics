import { describe, expect, it } from 'vitest';
import { cityName, countryName, netFollowerDaily } from '@/lib/igMetrics';
import type { IgHistoryRow } from '@/api/schemas';

const rowsOf = (
  days: Array<{ day: string; follows?: number | null; unfollows?: number | null }>,
): IgHistoryRow[] => days as unknown as IgHistoryRow[];

describe('netFollowerDaily — чистое движение базы из архива (follows − unfollows подневно)', () => {
  it('вычитает отписки подневно: отрицательно, когда unfollows > follows (баг «база выросла»)', () => {
    const rows = rowsOf([
      { day: '2026-07-01', follows: 30, unfollows: 40 },
      { day: '2026-07-02', follows: 27, unfollows: 42 },
    ]);
    expect(netFollowerDaily(rows)).toEqual([
      { day: '2026-07-01', value: -10 },
      { day: '2026-07-02', value: -15 },
    ]);
  });

  it('день без колонки follows пропущен, undefined → пусто (honest degrade)', () => {
    const rows = rowsOf([
      { day: '2026-07-01', follows: null, unfollows: 5 },
      { day: '2026-07-02', follows: 12, unfollows: 4 },
    ]);
    expect(netFollowerDaily(rows)).toEqual([{ day: '2026-07-02', value: 8 }]);
    expect(netFollowerDaily(undefined)).toEqual([]);
  });

  it('день без парного unfollows = 0 вычета (выравнивание по дню follows)', () => {
    const rows = rowsOf([
      { day: '2026-07-01', follows: 12, unfollows: null },
      { day: '2026-07-02', follows: 9, unfollows: 4 },
    ]);
    expect(netFollowerDaily(rows)).toEqual([
      { day: '2026-07-01', value: 12 },
      { day: '2026-07-02', value: 5 },
    ]);
  });
});

describe('geo normalization', () => {
  it('cityName drops the region and localizes known RU/CIS cities', () => {
    expect(cityName('London, England')).toBe('London');
    expect(cityName('Moscow, Moscow')).toBe('Москва');
    expect(cityName('Yekaterinburg, Sverdlovsk Oblast')).toBe('Екатеринбург');
    expect(cityName('Москва, Москва')).toBe('Москва');
  });

  it('countryName resolves a code and passes non-codes through', () => {
    expect(countryName('US')).toBeTruthy();
    expect(countryName('Россия')).toBe('Россия');
  });
});
