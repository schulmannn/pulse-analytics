import { describe, expect, it } from 'vitest';
import type { NormalizedPost } from '@/lib/posts';
import {
  CONTENT_DEFAULTS,
  applyContentFilters,
  classifyFormat,
  filterPosts,
  matchesQuery,
  parseContentFilters,
  sortPosts,
} from '@/lib/contentFilters';

function post(over: Partial<NormalizedPost>): NormalizedPost {
  return {
    id: 1,
    caption: '',
    date: '2026-07-10T10:00:00Z',
    thumb: null,
    permalink: null,
    mediaType: null,
    reach: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    eng: 0,
    reactionsDetail: [],
    hashtags: [],
    albumSize: 0,
    pinned: false,
    erv: null,
    virality: null,
    er: null,
    ...over,
  };
}

describe('parseContentFilters — normalises every param to a valid default', () => {
  it('empty params → all defaults', () => {
    expect(parseContentFilters(new URLSearchParams())).toEqual(CONTENT_DEFAULTS);
  });

  it('valid params parse through', () => {
    const f = parseContentFilters(
      new URLSearchParams('period=7&q=launch&format=video&sort=erv&order=asc'),
    );
    expect(f).toEqual({ period: 7, q: 'launch', format: 'video', sort: 'erv', order: 'asc' });
  });

  it('period=all → 0 («Всё»); period=30 and garbage → 30 default', () => {
    expect(parseContentFilters(new URLSearchParams('period=all')).period).toBe(0);
    expect(parseContentFilters(new URLSearchParams('period=30')).period).toBe(30);
    expect(parseContentFilters(new URLSearchParams('period=999')).period).toBe(30);
    expect(parseContentFilters(new URLSearchParams('period=7d')).period).toBe(30);
  });

  it('invalid format/sort/order fall back to defaults', () => {
    const f = parseContentFilters(new URLSearchParams('format=gif&sort=karma&order=sideways'));
    expect(f.format).toBe('all');
    expect(f.sort).toBe('reach');
    expect(f.order).toBe('desc');
  });

  it('keeps spaces while typing a multi-word query', () => {
    expect(parseContentFilters(new URLSearchParams('q=product%20launch')).q).toBe('product launch');
    expect(parseContentFilters(new URLSearchParams('q=launch%20')).q).toBe('launch ');
  });
});

describe('applyContentFilters — defaults omitted, other params preserved', () => {
  it('all-default filters strip every owned param but keep unrelated ones', () => {
    const prev = new URLSearchParams('campaign=12&view=campaigns&period=7&q=x&format=video&sort=erv&order=asc');
    const next = applyContentFilters(prev, CONTENT_DEFAULTS);
    expect(next.get('campaign')).toBe('12');
    expect(next.get('view')).toBe('campaigns');
    expect(next.has('period')).toBe(false);
    expect(next.has('q')).toBe(false);
    expect(next.has('format')).toBe(false);
    expect(next.has('sort')).toBe(false);
    expect(next.has('order')).toBe(false);
  });

  it('non-default filters serialise; period 0 → all', () => {
    const next = applyContentFilters(new URLSearchParams('campaign=3'), {
      period: 0,
      q: 'promo',
      format: 'album',
      sort: 'date',
      order: 'asc',
    });
    expect(next.get('campaign')).toBe('3');
    expect(next.get('period')).toBe('all');
    expect(next.get('q')).toBe('promo');
    expect(next.get('format')).toBe('album');
    expect(next.get('sort')).toBe('date');
    expect(next.get('order')).toBe('asc');
  });

  it('round-trips: parse(apply(f)) === f', () => {
    const f = { period: 90 as const, q: 'sale', format: 'photo' as const, sort: 'likes' as const, order: 'asc' as const };
    expect(parseContentFilters(applyContentFilters(new URLSearchParams(), f))).toEqual(f);
  });

  it('drops a whitespace-only query but preserves meaningful inter-word spaces', () => {
    expect(applyContentFilters(new URLSearchParams(), { ...CONTENT_DEFAULTS, q: '   ' }).has('q')).toBe(false);
    expect(applyContentFilters(new URLSearchParams(), { ...CONTENT_DEFAULTS, q: 'product launch' }).get('q')).toBe('product launch');
  });
});

describe('classifyFormat — honest, mutually-exclusive buckets', () => {
  it('album wins over media type when albumSize > 1', () => {
    expect(classifyFormat(post({ mediaType: 'photo', albumSize: 3 }))).toBe('album');
    expect(classifyFormat(post({ mediaType: 'video', albumSize: 2 }))).toBe('album');
  });
  it('single-item media and text', () => {
    expect(classifyFormat(post({ mediaType: 'video', albumSize: 1 }))).toBe('video');
    expect(classifyFormat(post({ mediaType: 'photo', albumSize: 0 }))).toBe('photo');
    expect(classifyFormat(post({ mediaType: null }))).toBe('text');
  });
});

describe('matchesQuery — case-insensitive over caption + hashtags', () => {
  it('empty query matches everything', () => {
    expect(matchesQuery(post({ caption: 'anything' }), '')).toBe(true);
    expect(matchesQuery(post({ caption: 'anything' }), '   ')).toBe(true);
  });
  it('caption match is case-insensitive', () => {
    expect(matchesQuery(post({ caption: 'Большой Запуск' }), 'запуск')).toBe(true);
    expect(matchesQuery(post({ caption: 'nope' }), 'запуск')).toBe(false);
  });
  it('hashtag match', () => {
    expect(matchesQuery(post({ caption: '', hashtags: ['Sale', 'News'] }), 'sale')).toBe(true);
  });
});

describe('filterPosts — format + query compose', () => {
  const posts = [
    post({ id: 1, caption: 'launch video', mediaType: 'video', albumSize: 1 }),
    post({ id: 2, caption: 'launch photo', mediaType: 'photo', albumSize: 0 }),
    post({ id: 3, caption: 'gallery', mediaType: 'photo', albumSize: 4 }),
    post({ id: 4, caption: 'plain note', mediaType: null }),
  ];
  it('format all + empty query = pass-through', () => {
    expect(filterPosts(posts, { format: 'all', q: '' })).toHaveLength(4);
  });
  it('format video keeps only the single video', () => {
    expect(filterPosts(posts, { format: 'video', q: '' }).map((p) => p.id)).toEqual([1]);
  });
  it('album bucket excludes single photos', () => {
    expect(filterPosts(posts, { format: 'album', q: '' }).map((p) => p.id)).toEqual([3]);
  });
  it('format + query intersect', () => {
    expect(filterPosts(posts, { format: 'video', q: 'launch' }).map((p) => p.id)).toEqual([1]);
    expect(filterPosts(posts, { format: 'photo', q: 'launch' }).map((p) => p.id)).toEqual([2]);
  });
});

describe('sortPosts — direction + null handling', () => {
  const posts = [
    post({ id: 1, reach: 100, erv: 2 }),
    post({ id: 2, reach: 300, erv: null }),
    post({ id: 3, reach: 200, erv: 5 }),
  ];
  it('reach desc / asc', () => {
    expect(sortPosts(posts, 'reach', 'desc').map((p) => p.id)).toEqual([2, 3, 1]);
    expect(sortPosts(posts, 'reach', 'asc').map((p) => p.id)).toEqual([1, 3, 2]);
  });
  it('null metric sinks to the bottom in either direction', () => {
    expect(sortPosts(posts, 'erv', 'desc').map((p) => p.id)).toEqual([3, 1, 2]);
    expect(sortPosts(posts, 'erv', 'asc').map((p) => p.id)).toEqual([1, 3, 2]);
  });
  it('date sort orders by timestamp', () => {
    const dated = [
      post({ id: 1, date: '2026-07-01T00:00:00Z' }),
      post({ id: 2, date: '2026-07-03T00:00:00Z' }),
      post({ id: 3, date: '2026-07-02T00:00:00Z' }),
    ];
    expect(sortPosts(dated, 'date', 'desc').map((p) => p.id)).toEqual([2, 3, 1]);
  });
  it('does not mutate the input array', () => {
    const input = [post({ id: 1, reach: 1 }), post({ id: 2, reach: 2 })];
    sortPosts(input, 'reach', 'desc');
    expect(input.map((p) => p.id)).toEqual([1, 2]);
  });
});
