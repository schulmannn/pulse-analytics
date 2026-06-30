import { describe, expect, it } from 'vitest';
import { buildIgInsights } from '@/lib/igInsights';

describe('buildIgInsights', () => {
  it('returns nothing for empty input', () => {
    expect(buildIgInsights({})).toEqual([]);
  });

  it('reports net growth (follows > unfollows) with both numbers as evidence', () => {
    const [g] = buildIgInsights({ netFollowers: 1240, follows: 1858, unfollows: 618 });
    expect(g.tone).toBe('up');
    expect(g.text).toContain('растёт');
    expect(g.evidence).toContain('+1 240');
    expect(g.evidence).toContain('отписки −618');
    expect(g.confidence).toBe('high');
  });

  it('flags a net loss when unfollows exceed follows', () => {
    const [g] = buildIgInsights({ netFollowers: -23, follows: 595, unfollows: 618 });
    expect(g.tone).toBe('down');
    expect(g.text).toContain('теряет');
    expect(g.evidence).toContain('−23');
    expect(g.evidence).toContain('подписки +595');
  });

  it('marks a falling ER as a down-insight, numbers as evidence', () => {
    const out = buildIgInsights({ erReach: 1.8, erReachPrev: 2.4 });
    expect(out[0].tone).toBe('down');
    expect(out[0].text).toContain('снизилась');
    expect(out[0].evidence).toContain('1.80%');
    expect(out[0].evidence).toContain('2.40%');
  });

  it('surfaces a dominant format and only a meaningful, repeated hashtag lift', () => {
    const out = buildIgInsights({
      bestFormat: { label: 'Reels', sharePct: 47, interactions: 470, total: 1000 },
      topHashtag: { tag: '#smm', lift: 3, count: 3 }, // lift below threshold → dropped
    });
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain('Reels');
    expect(out[0].evidence).toContain('47%');

    const out2 = buildIgInsights({ topHashtag: { tag: '#smm', lift: 22, count: 3 } });
    expect(out2[0].text).toContain('#smm');
    expect(out2[0].evidence).toContain('+22%');
  });

  it('drops a hashtag used only once, even with a high lift', () => {
    expect(buildIgInsights({ topHashtag: { tag: '#smm', lift: 22, count: 1 } })).toEqual([]);
  });

  it('never emits a best-time insight when there is no online data (bestSlot null)', () => {
    const out = buildIgInsights({ bestSlot: null, erReach: 2 });
    expect(out.some((i) => i.text.includes('активнее всего'))).toBe(false);
  });
});
