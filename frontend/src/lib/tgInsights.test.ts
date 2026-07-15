import { describe, expect, it } from 'vitest';
import { buildTgInsights } from './tgInsights';

describe('buildTgInsights', () => {
  it('returns nothing for an empty input', () => {
    expect(buildTgInsights({})).toEqual([]);
  });

  it('flags a views drop with a why + action and attaches the top post as evidence', () => {
    const out = buildTgInsights({
      viewsDelta: { dir: 'down', pct: 12 },
      topPost: { caption: 'Вакансия', reach: 5000, erv: 6.7, permalink: 'https://t.me/x/1' },
    });
    expect(out).toHaveLength(1);
    expect(out[0].tone).toBe('down');
    expect(out[0].statement).toContain('Просмотры канала');
    expect(out[0].statement).toContain('снизились на 12.0%');
    expect(out[0].why).toContain('дневной поток просмотров');
    expect(out[0].action).toBeTruthy();
    expect(out[0].evidence?.permalink).toBe('https://t.me/x/1');
  });

  it('reports a subscriber drop as a down-tone alert', () => {
    const out = buildTgInsights({ subscriberChange: -108 });
    expect(out).toHaveLength(1);
    expect(out[0].tone).toBe('down');
    expect(out[0].statement).toContain('База сократилась на 108 подписчиков');
  });

  it('only surfaces a hashtag above the lift threshold', () => {
    expect(buildTgInsights({ topHashtag: { tag: '#job', lift: 3 } })).toHaveLength(0);
    const out = buildTgInsights({ topHashtag: { tag: '#job', lift: 42 } });
    expect(out).toHaveLength(1);
    expect(out[0].statement).toContain('#job');
  });

  it('adds a low-confidence note to the best-time insight when posts are few', () => {
    const out = buildTgInsights({ bestWeekday: 'Чт', peakHour: 6, postsCount: 4 });
    expect(out[0].statement).toContain('Чт');
    expect(out[0].why).toContain('Мало постов');
  });
});
