import { describe, expect, it } from 'vitest';
import {
  deriveContentOpportunities,
  opportunityShareBoundary,
  opportunityY,
  resolveOpportunityChipOverlaps,
} from '@/lib/contentOpportunity';
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

describe('resolveOpportunityChipOverlaps', () => {
  it('leaves chips untouched when nothing intersects on both axes', () => {
    const chips = [
      { x: 20, y: 50 },
      { x: 60, y: 50 },
      { x: 20, y: 20 },
    ];
    expect(resolveOpportunityChipOverlaps(chips)).toEqual(chips);
  });

  it('drops the later (by x) of two touching chips one chip-height + gap below', () => {
    const chips = [
      { x: 40, y: 50 },
      { x: 42, y: 52 },
    ];
    const resolved = resolveOpportunityChipOverlaps(chips);
    expect(resolved[0]).toEqual({ x: 40, y: 50 });
    expect(resolved[1]).toEqual({ x: 42, y: 50 - 14 });
  });

  it('cascades a stack of coincident chips downwards without new collisions', () => {
    const chips = [
      { x: 50, y: 50 },
      { x: 51, y: 50 },
      { x: 52, y: 50 },
    ];
    const resolved = resolveOpportunityChipOverlaps(chips);
    expect(resolved.map((chip) => chip.y)).toEqual([50, 36, 22]);
  });

  it('shifts up instead of leaving the plane at the bottom edge', () => {
    const chips = [
      { x: 30, y: 14 },
      { x: 31, y: 13 },
    ];
    const resolved = resolveOpportunityChipOverlaps(chips);
    expect(resolved[0]).toEqual({ x: 30, y: 14 });
    // 13 → вниз было бы 0 (< minY 12), поэтому чип уезжает над конфликтующим: 14 + 14.
    expect(resolved[1]).toEqual({ x: 31, y: 28 });
  });

  it('clamps the upward cascade at the top edge of the plane', () => {
    const chips = [
      { x: 70, y: 13 },
      { x: 71, y: 86 },
      { x: 72, y: 13 },
    ];
    const resolved = resolveOpportunityChipOverlaps(chips);
    // Третий чип: вниз некуда (13 − 14 < 12), вверх каскад через 27 → без конфликтов, в границах.
    expect(resolved[2].y).toBeGreaterThanOrEqual(12);
    expect(resolved[2].y).toBeLessThanOrEqual(88);
    expect(Math.abs(resolved[2].y - resolved[0].y)).toBeGreaterThanOrEqual(14);
  });
});
