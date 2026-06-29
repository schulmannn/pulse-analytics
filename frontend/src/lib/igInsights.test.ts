import { describe, expect, it } from 'vitest';
import { buildIgInsights } from '@/lib/igInsights';

describe('buildIgInsights', () => {
  it('returns nothing for empty input', () => {
    expect(buildIgInsights({})).toEqual([]);
  });

  it('phrases accelerating growth as an up-insight with grouped numbers', () => {
    const [growth] = buildIgInsights({ newFollowers: 1240, followersDelta: { dir: 'up', pct: 18 } });
    expect(growth.tone).toBe('up');
    expect(growth.text).toContain('+1 240');
    expect(growth.text).toContain('↑18%');
  });

  it('marks a falling ER as a down-insight', () => {
    const out = buildIgInsights({ erReach: 1.8, erReachPrev: 2.4 });
    expect(out[0]).toEqual({ tone: 'down', text: 'Вовлечённость снизилась до 1.80% (было 2.40%).' });
  });

  it('surfaces best format and only a meaningful (>5%) hashtag lift', () => {
    const out = buildIgInsights({
      bestFormat: { label: 'Reels', sharePct: 47 },
      topHashtag: { tag: '#smm', lift: 3 }, // below threshold → dropped
    });
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain('Лучший формат — Reels: 47%');

    const out2 = buildIgInsights({ topHashtag: { tag: '#smm', lift: 22 } });
    expect(out2[0].text).toContain('#smm');
    expect(out2[0].text).toContain('+22%');
  });
});
