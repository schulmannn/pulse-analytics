import { describe, expect, it } from 'vitest';
import { CampaignSummarySchema } from '@/api/schemas';
import {
  comparisonText,
  comparisonUnavailableText,
  campaignExtremes,
  formatLabel,
  formatSlices,
  platformKpis,
  ratioLabel,
  timelineSeries,
} from '@/lib/campaignSummary';

const SUMMARY = CampaignSummarySchema.parse({
  campaign: { id: 5, workspace_id: 2, name: 'Запуск', status: 'active' },
  posts_total: 5,
  inaccessible_posts: 0,
  undated_posts: 0,
  period: { from: '2026-06-10', to: '2026-06-12' },
  tg: { posts: 4, views: 13000, avg: 3250, median: 3000, reactions: 90, forwards: 33, replies: 14,
    best: { network: 'tg', post_ref: '103', value: 6000, ratio: 2 },
    worst: { network: 'tg', post_ref: '101', value: 1000, ratio: 0.3 } },
  ig: { posts: 1, reach: 800, views: 1200, likes: 80, median: 800, avg: 800 },
  by_source: [],
  by_format: [
    { network: 'tg', media_type: 'photo', posts: 3, tg_views: 11000 },
    { network: 'ig', media_type: 'REELS', posts: 1, ig_reach: 800 },
  ],
  timeline: [
    { day: '2026-06-12', posts: 1, tg_views: 6000 },
    { day: '2026-06-10', posts: 1, tg_views: 1000 },
    { day: '2026-06-11', posts: 3, tg_views: 6000, ig_reach: 800 },
  ],
  comparison: { available: true, network: 'tg', prev_posts: 3, prev_views_avg: 700, prev_views_median: 700, views_avg_delta_pct: 364.3 },
});

describe('timelineSeries', () => {
  it('сортирует дни, строит серии и флаги платформ', () => {
    const s = timelineSeries(SUMMARY.timeline);
    expect(s.labels).toEqual(['10.06', '11.06', '12.06']);
    expect(s.posts).toEqual([1, 3, 1]);
    expect(s.tgViews).toEqual([1000, 6000, 6000]);
    expect(s.igReach).toEqual([0, 800, 0]);
    expect(s.hasTg).toBe(true);
    expect(s.hasIg).toBe(true);
  });
  it('пустой таймлайн → пустые серии без флагов', () => {
    const s = timelineSeries([]);
    expect(s.labels).toEqual([]);
    expect(s.hasTg).toBe(false);
    expect(s.hasIg).toBe(false);
  });
});

describe('campaignExtremes', () => {
  it('compares platforms by ratio to their own median instead of always preferring Telegram', () => {
    const extremes = campaignExtremes({
      tg: { posts: 3, best: { network: 'tg', ratio: 1.8 }, worst: { network: 'tg', ratio: 0.6 } },
      ig: { posts: 3, best: { network: 'ig', ratio: 2.4 }, worst: { network: 'ig', ratio: 0.3 } },
    });
    expect(extremes.best?.network).toBe('ig');
    expect(extremes.worst?.network).toBe('ig');
  });
});

describe('форматы', () => {
  it('подписи разводят платформы (методологии не смешиваются)', () => {
    expect(formatLabel('tg', 'photo')).toBe('TG · Фото');
    expect(formatLabel('ig', 'REELS')).toBe('IG · Reels');
    expect(formatLabel('ig', null)).toBe('IG · Без типа');
  });
  it('слайсы считаются по числу публикаций и сортируются по убыванию', () => {
    const s = formatSlices(SUMMARY.by_format);
    expect(s.labels).toEqual(['TG · Фото', 'IG · Reels']);
    expect(s.values).toEqual([3, 1]);
    expect(s.titles[0]).toContain('просмотров');
    expect(s.titles[1]).toContain('охват');
  });
});

describe('сравнение с предыдущим равным периодом', () => {
  it('доступно → человекочитаемый текст с дельтой и базой', () => {
    const text = comparisonText(SUMMARY);
    expect(text).toContain('+364%');
    expect(text).toContain('3 публ.');
    expect(comparisonUnavailableText(SUMMARY)).toBeNull();
  });
  it('недостаточно данных → честный insufficient-state, а не пустота', () => {
    const summary = CampaignSummarySchema.parse({ comparison: { available: false, reason: 'insufficient_data' } });
    expect(comparisonText(summary)).toBeNull();
    expect(comparisonUnavailableText(summary)).toMatch(/недостаточно/i);
  });
});

describe('platformKpis', () => {
  it('строит раздельные блоки TG/IG с подписями методологии', () => {
    const k = platformKpis(SUMMARY);
    expect(k.tg.map((t) => t.label)).toContain('Просмотры');
    expect(k.tg.find((t) => t.label === 'Просмотры')?.hint).toMatch(/показы/i);
    expect(k.ig.find((t) => t.label === 'Сумма охватов')?.hint).toMatch(/не дедуплицируется/i);
    // Ни одна плитка не суммирует tg+ig.
    expect(k.tg.find((t) => t.label === 'Просмотры')?.value).not.toContain('14');
  });
  it('платформа без постов не даёт плиток', () => {
    const k = platformKpis(CampaignSummarySchema.parse({ tg: { posts: 0 }, ig: { posts: 0 } }));
    expect(k.tg).toEqual([]);
    expect(k.ig).toEqual([]);
  });
});

describe('ratioLabel', () => {
  it('коэффициент к медиане своей платформы', () => {
    expect(ratioLabel(2)).toBe('×2.0 к медиане');
    expect(ratioLabel(0.34)).toBe('×0.3 к медиане');
    expect(ratioLabel(null)).toBeNull();
  });
});
