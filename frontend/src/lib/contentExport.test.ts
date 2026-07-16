import { describe, expect, it } from 'vitest';
import { tgContentRows } from '@/lib/contentExport';
import type { NormalizedPost } from '@/lib/posts';

const post = (over: Partial<NormalizedPost>): NormalizedPost => ({
  id: 1,
  caption: '',
  date: '2026-06-10T09:00:00Z',
  thumb: null,
  permalink: 'https://t.me/chan/1',
  mediaType: 'photo',
  reach: 100,
  likes: 5,
  comments: 2,
  shares: 3,
  eng: 10,
  reactionsDetail: [],
  hashtags: [],
  albumSize: 0,
  pinned: false,
  erv: 1.234,
  virality: 3,
  er: null,
  ...over,
});

describe('tgContentRows', () => {
  it('projects one wide row per publication, preserving the caller order (current sort)', () => {
    const rows = tgContentRows([post({ id: 2, reach: 200 }), post({ id: 1, reach: 100 })]);
    expect(rows.map((r) => r.views)).toEqual([200, 100]); // order preserved, not re-sorted
    expect(Object.keys(rows[0] ?? {})).toEqual([
      'date', 'format', 'caption', 'views', 'reactions', 'reposts', 'comments', 'erv_pct', 'virality_pct', 'er_pct', 'permalink',
    ]);
  });

  it('labels media format and rounds rate metrics; missing rate → empty cell', () => {
    const [a] = tgContentRows([post({ albumSize: 3, erv: 1.234, er: null })]);
    expect(a?.format).toBe('Альбом');
    expect(a?.erv_pct).toBe(1.2);
    expect(a?.er_pct).toBe(''); // never a fabricated 0 for a missing rate
  });

  it('flattens caption whitespace', () => {
    const [a] = tgContentRows([post({ caption: 'line one\n\n  line two' })]);
    expect(a?.caption).toBe('line one line two');
  });

  it('does not truncate the loaded publication text', () => {
    const caption = 'x'.repeat(500);
    expect(tgContentRows([post({ caption })])[0]?.caption).toBe(caption);
  });
});
