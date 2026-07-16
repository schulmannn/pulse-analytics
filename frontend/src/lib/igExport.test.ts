import { describe, expect, it } from 'vitest';
import { igContentRows } from '@/lib/igExport';
import type { IgPost } from '@/api/schemas';

const post = (over: Partial<IgPost>): IgPost =>
  ({
    id: '1',
    timestamp: '2026-06-10T09:00:00Z',
    media_type: 'IMAGE',
    reach: 100,
    views: 120,
    like_count: 5,
    comments_count: 2,
    saved: 1,
    shares: 0,
    caption: '',
    permalink: 'https://instagram.com/p/1',
    ...over,
  }) as IgPost;

describe('igContentRows', () => {
  it('projects one wide row per publication, preserving the caller order', () => {
    const rows = igContentRows([post({ id: '2', reach: 200 }), post({ id: '1', reach: 100 })]);
    expect(rows.map((r) => r.reach)).toEqual([200, 100]);
    expect(Object.keys(rows[0] ?? {})).toEqual([
      'date', 'type', 'reach', 'views', 'interactions', 'likes', 'comments', 'saved', 'shares', 'er_pct', 'caption', 'permalink',
    ]);
  });

  it('keeps reach and views as separate columns (different metrics)', () => {
    const [a] = igContentRows([post({ reach: 100, views: 120 })]);
    expect(a?.reach).toBe(100);
    expect(a?.views).toBe(120);
    expect(a?.interactions).toBe(8);
    expect(a?.er_pct).toBe(8);
  });

  it('keeps unavailable metrics empty instead of fabricating zeroes', () => {
    const [a] = igContentRows([
      post({ reach: null, views: null, like_count: null, comments_count: null, saved: null, shares: null }),
    ]);
    expect(a?.reach).toBe('');
    expect(a?.views).toBe('');
    expect(a?.interactions).toBe('');
    expect(a?.er_pct).toBe('');
  });

  it('does not truncate the loaded publication text', () => {
    const caption = 'x'.repeat(500);
    expect(igContentRows([post({ caption })])[0]?.caption).toBe(caption);
  });
});
