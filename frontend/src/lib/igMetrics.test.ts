import { describe, expect, it } from 'vitest';
import { cityName, countryName, followerLevelSeries, netFollowerDaily, postInteractionsByFormat } from '@/lib/igMetrics';
import type { IgHistoryRow, IgPost } from '@/api/schemas';

describe('postInteractionsByFormat — campaign-scoped форматы', () => {
  it('агрегирует только переданные посты и использует сумму действий как fallback', () => {
    const posts = [
      { media_product_type: 'REELS', total_interactions: 25 },
      { media_product_type: 'REELS', total_interactions: 0, like_count: 4, comments_count: 2, saved: 3, shares: 1 },
      { media_type: 'IMAGE', like_count: 5 },
    ] as IgPost[];
    expect(postInteractionsByFormat(posts)).toEqual([
      { label: 'REELS', value: 35 },
      { label: 'IMAGE', value: 5 },
    ]);
  });
});

const rowsOf = (
  days: Array<{ day: string; follows?: number | null; unfollows?: number | null; followers_total?: number | null }>,
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

describe('followerLevelSeries — абсолютный уровень базы (аналог ТГ «Подписчики»)', () => {
  const today = new Date().toISOString().slice(0, 10);

  it('реконструирует прошлое назад от живого followersNow по дневному net', () => {
    const rows = rowsOf([
      { day: '2026-07-01', follows: 10, unfollows: 3 },  // net +7
      { day: '2026-07-02', follows: 2, unfollows: 8 },   // net −6
    ]);
    const s = followerLevelSeries(rows, 1000);
    // Сегодня = 1000 (живой якорь); конец 02.07 = 1000 − 0 (net сегодняшнего дня неизвестен и не
    // нужен — сегодняшняя точка ЯКОРЬ, а не шаг); шаг назад: конец 01.07 = конец 02.07 − net(02.07).
    expect(s).toEqual([
      { day: '2026-07-01', value: 1006 },
      { day: '2026-07-02', value: 1000 },
      { day: today, value: 1000 },
    ]);
  });

  it('реальный якорь followers_total ПОБЕЖДАЕТ реконструкцию и чинит дрейф от пропуска', () => {
    const rows = rowsOf([
      { day: '2026-07-01', follows: 5, unfollows: 0 },                        // net +5
      { day: '2026-07-02', follows: 1, unfollows: 0, followers_total: 900 }, // реальный уровень
      { day: '2026-07-03', follows: 10, unfollows: 2 },                       // net +8
    ]);
    const s = followerLevelSeries(rows, 950);
    // 03.07 = 950 − 0? Нет: сегодня(950) − net(сегодня)=0 → 03.07 = 950 − net? Шаг назад от
    // сегодняшнего якоря вычитает net СЕГОДНЯШНЕГО дня (нет в архиве → 0): конец 03.07 = 950.
    // Конец 02.07 = РЕАЛЬНЫЙ 900 (перекрывает 950−8=942); конец 01.07 = 900 − net(02.07) = 899.
    expect(s).toEqual([
      { day: '2026-07-01', value: 899 },
      { day: '2026-07-02', value: 900 },
      { day: '2026-07-03', value: 950 },
      { day: today, value: 950 },
    ]);
  });

  it('без единого якоря (нет followersNow и followers_total) уровень не выводим — пусто', () => {
    const rows = rowsOf([{ day: '2026-07-01', follows: 5, unfollows: 1 }]);
    expect(followerLevelSeries(rows, null)).toEqual([]);
    expect(followerLevelSeries(undefined, undefined)).toEqual([]);
  });

  it('followers_total без net-строк тоже даёт линию (архив уровней самодостаточен)', () => {
    const rows = rowsOf([
      { day: '2026-07-01', followers_total: 800 },
      { day: '2026-07-02', followers_total: 812 },
    ]);
    expect(followerLevelSeries(rows, null)).toEqual([
      { day: '2026-07-01', value: 800 },
      { day: '2026-07-02', value: 812 },
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
