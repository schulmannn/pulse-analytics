import { describe, expect, it } from 'vitest';
import { deriveContentOpportunities, opportunityShareBoundary, opportunityY } from '@/lib/contentOpportunity';
import type { NormalizedPost } from '@/lib/posts';

function post(mediaType: string, reach: number, erv = 5): NormalizedPost {
  return {
    id: null,
    caption: '',
    date: '2026-07-01',
    thumb: null,
    permalink: null,
    mediaType,
    reach,
    likes: 0,
    comments: 0,
    shares: 0,
    eng: 0,
    reactionsDetail: [],
    hashtags: [],
    albumSize: 0,
    pinned: false,
    erv,
    virality: null,
    er: null,
  };
}

describe('deriveContentOpportunities', () => {
  it('aligns the average-reach point and the equal-share decision boundary with the chart guides', () => {
    expect(opportunityY(1)).toBe(50);
    expect(opportunityShareBoundary(3)).toBeCloseTo(1 / 3);
  });

  it('marks a proven, underused high-reach format as an opportunity', () => {
    const rows = [
      ...Array.from({ length: 12 }, () => post('text', 100)),
      ...Array.from({ length: 4 }, () => post('video', 300)),
    ];
    const video = deriveContentOpportunities(rows).find((item) => item.key === 'video');
    expect(video?.confidence).toBe('medium');
    expect(video?.reachIndex).toBeGreaterThan(1.1);
    expect(video?.opportunity).toBe(true);
  });

  it('does not recommend a format from a tiny sample', () => {
    const rows = [...Array.from({ length: 10 }, () => post('text', 100)), post('video', 1000)];
    const video = deriveContentOpportunities(rows).find((item) => item.key === 'video');
    expect(video?.confidence).toBe('low');
    expect(video?.opportunity).toBe(false);
  });
});
