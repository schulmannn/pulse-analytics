import { describe, expect, it } from 'vitest';
import {
  aggregateOnline,
  cityName,
  countryName,
  followerLevelSeries,
  igCountryItems,
  igDemographicsCoverage,
  igFormatEngagementItems,
  igReelsWatchTime,
  igStoryNavItems,
  netFollowerDaily,
  postInteractionsByFormat,
  IG_AUDIENCE_INFO,
  IG_COVERAGE_FULL,
  IG_DEMOGRAPHICS_EMPTY,
  IG_DEMOGRAPHICS_MIN_FOLLOWERS,
} from '@/lib/igMetrics';
import type { IgBreakdowns, IgHistoryRow, IgOnline, IgPost, IgStory } from '@/api/schemas';

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

describe('shared chart-card derivations (card ↔ /metrics/ig-* parity)', () => {
  it('igCountryItems ranks high→low, localizes, and returns the FULL list (card slices its preview)', () => {
    const breakdowns = {
      data: [
        {
          name: 'follower_demographics',
          total_value: {
            breakdowns: [
              {
                dimension_keys: ['country'],
                results: [
                  { dimension_values: ['US'], value: 30 },
                  { dimension_values: ['RU'], value: 120 },
                  { dimension_values: ['DE'], value: 45 },
                ],
              },
            ],
          },
        },
      ],
    } as unknown as IgBreakdowns;
    const items = igCountryItems(breakdowns);
    expect(items.map((i) => i.value)).toEqual([120, 45, 30]); // ranked high→low, nothing dropped
    expect(items[0].label).toBe(countryName('RU'));
    expect(items[0].display).toBe('120');
  });

  it('igFormatEngagementItems ranks formats and maps labels/hues', () => {
    const items = igFormatEngagementItems([
      { label: 'FEED', value: 100 },
      { label: 'REELS', value: 250 },
    ]);
    expect(items.map((i) => i.label)).toEqual(['Reels', 'Лента']);
    expect(items[0].color).toBeTruthy();
  });

  it('igStoryNavItems sums navigation actions and drops empty buckets', () => {
    const stories = [
      { navigation: { tap_forward: 5, tap_exit: 2 } },
      { navigation: { tap_forward: 3, swipe_forward: 4 } },
    ] as unknown as IgStory[];
    expect(igStoryNavItems(stories)).toEqual([
      { label: 'Вперёд', value: 8, display: '8' },
      { label: 'Выход', value: 2, display: '2' },
      { label: 'Свайп к следующему', value: 4, display: '4' },
    ]);
    expect(igStoryNavItems(undefined)).toEqual([]);
  });

  it('igReelsWatchTime keeps only REELS, averages ms→sec, and totals watch hours', () => {
    const posts = [
      { media_product_type: 'REELS', ig_reels_avg_watch_time: 8000, ig_reels_video_view_total_time: 3_600_000, views: 1200 },
      { media_product_type: 'REELS', ig_reels_avg_watch_time: 4000, ig_reels_video_view_total_time: 1_800_000, views: 600 },
      { media_product_type: 'FEED', ig_reels_avg_watch_time: 9999 },
    ] as unknown as IgPost[];
    const r = igReelsWatchTime(posts);
    expect(r.count).toBe(2);
    expect(r.values).toEqual([8, 4]);
    expect(r.avgWatchAll).toBe(6);
    expect(Math.round(r.totalWatchHours)).toBe(2);
    expect(r.labels).toEqual(['R1', 'R2']);
  });
});

/**
 * `aggregateOnline` отдаёт оба конца шкалы: пик — максимум по сетке, затишье — минимум среди
 * НЕНУЛЕВЫХ часов. Ноль в этой метрике неотличим от «Instagram не отдал час» (ради той же
 * неотличимости в агрегате живёт `hasSignal`), поэтому нулевая ячейка не имеет права называться
 * самым тихим временем.
 */
describe('aggregateOnline — пик и затишье', () => {
  const online = (value: Record<string, number>): IgOnline =>
    ({ data: [{ values: [{ end_time: '2026-01-05T07:00:00Z', value }] }] }) as unknown as IgOnline;

  it('затишье — минимум среди ненулевых часов, а не ночной ноль', () => {
    const { best, quiet, hasSignal } = aggregateOnline(online({ '3': 0, '9': 40, '18': 120, '21': 80 }));
    expect(hasSignal).toBe(true);
    expect(best).toMatchObject({ h: 18, v: 120 });
    expect(quiet).toMatchObject({ h: 9, v: 40 });
    expect(quiet?.w).toBe(best.w);
  });

  it('при одной ненулевой ячейке затишья нет', () => {
    const { best, quiet } = aggregateOnline(online({ '0': 0, '18': 120 }));
    expect(best).toMatchObject({ h: 18, v: 120 });
    expect(quiet).toBeNull();
  });

  it('при равных ненулевых ячейках затишье не повторяет пик', () => {
    const { best, quiet } = aggregateOnline(online({ '9': 50, '18': 50 }));
    expect(best).toMatchObject({ h: 9, v: 50 });
    expect(quiet).toBeNull();
  });

  it('пустая почасовая карта не даёт ни пика, ни затишья', () => {
    const { hasSignal, quiet } = aggregateOnline(online({ '0': 0, '1': 0 }));
    expect(hasSignal).toBe(false);
    expect(quiet).toBeNull();
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

describe('демография: порог и охват — один источник на карточку и страницу разбора', () => {
  const age = (...values: number[]) =>
    values.map((value, i) => ({ label: `bucket-${i}`, value, display: String(value) }));

  it('охват — дробь от базы, пока разрез её реально недобирает', () => {
    // 900 из 1000: Instagram расписал по возрастам девять десятых базы — оговорка обязана быть.
    expect(igDemographicsCoverage(age(400, 300, 200), 1000)).toBeCloseTo(0.9, 5);
  });

  it('молчит, когда говорить не о чем: полный охват, пустой разрез, неизвестная база', () => {
    // Полный разрез с законным недобором в пару процентов — оговорка была бы шумом.
    expect(igDemographicsCoverage(age(990), 1000)).toBeNull();
    expect(igDemographicsCoverage(age(1000), 1000)).toBeNull();
    // Пустой разрез — это не «охват 0%», а «данных нет»: об этом говорит пустое состояние.
    expect(igDemographicsCoverage([], 1000)).toBeNull();
    // База неизвестна — делить не на что.
    expect(igDemographicsCoverage(age(400), 0)).toBeNull();
  });

  it('порог полноты — ровно IG_COVERAGE_FULL, а не «примерно сто процентов»', () => {
    // Карточка и /metrics/ig-age зовут ОДНУ функцию, поэтому граница «сказать / промолчать» у них
    // физически одна. Проверяем её с обеих сторон — иначе порог мог бы тихо уехать в одном месте.
    expect(igDemographicsCoverage(age(IG_COVERAGE_FULL * 1000 - 1), 1000)).not.toBeNull();
    expect(igDemographicsCoverage(age(IG_COVERAGE_FULL * 1000), 1000)).toBeNull();
  });

  it('пустое состояние демографии НАЗЫВАЕТ порог и берёт его из константы', () => {
    // Текст и число обязаны ехать вместе: правка константы без правки фразы (или наоборот) —
    // это ответ «почему пусто», который перестал быть правдой.
    expect(IG_DEMOGRAPHICS_MIN_FOLLOWERS).toBe(100);
    expect(IG_DEMOGRAPHICS_EMPTY.reason).toContain(String(IG_DEMOGRAPHICS_MIN_FOLLOWERS));
    // Заголовок называет ИСТОЧНИК отказа, а не окно: разрез аудитории от периода не зависит.
    expect(IG_DEMOGRAPHICS_EMPTY.title).not.toContain('период');
  });

  it('у каждой из четырёх карточек демографии есть определение для ⓘ', () => {
    expect(Object.keys(IG_AUDIENCE_INFO).sort()).toEqual(['age', 'cities', 'countries', 'gender']);
    for (const info of Object.values(IG_AUDIENCE_INFO)) {
      expect(info.title.length).toBeGreaterThan(0);
      // Определение обязано отвечать на вопрос «от чего доля», иначе ⓘ — это просто заголовок ещё раз.
      expect(info.text.toLowerCase()).toContain('дол');
    }
  });
});
