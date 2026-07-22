import { describe, expect, it } from 'vitest';
import type { IgPost } from '@/api/schemas';
import {
  IG_CONTENT_DEFAULTS,
  IG_SECONDARY_DEFAULT,
  applyIgContentFilters,
  applyIgSecondaryView,
  classifyIgFormat,
  filterIgPosts,
  igEr,
  igInteractions,
  matchesIgQuery,
  parseIgContentFilters,
  parseIgSecondaryView,
  sortIgPosts,
} from '@/lib/igContentFilters';
import { periodMedian } from '@/lib/postMedian';

function post(over: Partial<IgPost>): IgPost {
  return { ...over } as IgPost;
}

describe('parseIgContentFilters — normalises every param to a valid default', () => {
  it('empty params → all defaults', () => {
    expect(parseIgContentFilters(new URLSearchParams())).toEqual(IG_CONTENT_DEFAULTS);
  });

  it('valid params parse through', () => {
    const f = parseIgContentFilters(new URLSearchParams('q=launch&format=reels&sort=saved&order=asc'));
    expect(f).toEqual({ q: 'launch', format: 'reels', sort: 'saved', order: 'asc' });
  });

  it('invalid format/sort/order fall back to defaults', () => {
    const f = parseIgContentFilters(new URLSearchParams('format=gif&sort=karma&order=sideways'));
    expect(f.format).toBe('all');
    expect(f.sort).toBe('reach');
    expect(f.order).toBe('desc');
  });

  it('parses the explicit no-sort third state (sort=none)', () => {
    expect(parseIgContentFilters(new URLSearchParams('sort=none')).sort).toBe('none');
    // A stray order alongside sort=none parses but is inert (sortIgPosts ignores it).
    expect(parseIgContentFilters(new URLSearchParams('sort=none&order=asc'))).toMatchObject({ sort: 'none', order: 'asc' });
  });

  it('keeps spaces while typing a multi-word query', () => {
    expect(parseIgContentFilters(new URLSearchParams('q=product%20launch')).q).toBe('product launch');
    expect(parseIgContentFilters(new URLSearchParams('q=launch%20')).q).toBe('launch ');
  });

  it('does NOT read a period param (period is owned by the IgFeed page control)', () => {
    // The four table params are the only ones parsed here; `period` is deliberately ignored.
    expect(Object.keys(parseIgContentFilters(new URLSearchParams('period=7')))).toEqual(
      Object.keys(IG_CONTENT_DEFAULTS),
    );
  });
});

describe('applyIgContentFilters — defaults omitted, other params preserved', () => {
  it('all-default filters strip every owned param but keep unrelated ones', () => {
    const prev = new URLSearchParams('campaign=12&view=campaigns&period=7&more=reels&q=x&format=video&sort=saved&order=asc');
    const next = applyIgContentFilters(prev, IG_CONTENT_DEFAULTS);
    expect(next.get('campaign')).toBe('12');
    expect(next.get('view')).toBe('campaigns');
    expect(next.get('period')).toBe('7');
    expect(next.get('more')).toBe('reels');
    expect(next.has('q')).toBe(false);
    expect(next.has('format')).toBe(false);
    expect(next.has('sort')).toBe(false);
    expect(next.has('order')).toBe(false);
  });

  it('non-default filters serialise', () => {
    const next = applyIgContentFilters(new URLSearchParams('campaign=3'), {
      q: 'promo',
      format: 'carousel',
      sort: 'date',
      order: 'asc',
    });
    expect(next.get('campaign')).toBe('3');
    expect(next.get('q')).toBe('promo');
    expect(next.get('format')).toBe('carousel');
    expect(next.get('sort')).toBe('date');
    expect(next.get('order')).toBe('asc');
  });

  it('round-trips: parse(apply(f)) === f', () => {
    const f = { q: 'sale', format: 'photo' as const, sort: 'views' as const, order: 'asc' as const };
    expect(parseIgContentFilters(applyIgContentFilters(new URLSearchParams(), f))).toEqual(f);
  });

  it('serialises sort=none and drops the now-meaningless order', () => {
    const next = applyIgContentFilters(new URLSearchParams('sort=views&order=asc'), {
      ...IG_CONTENT_DEFAULTS,
      sort: 'none',
      order: 'asc',
    });
    expect(next.get('sort')).toBe('none');
    expect(next.has('order')).toBe(false);
    // Round-trips: parse reads the no-sort state back with the default order.
    expect(parseIgContentFilters(next).sort).toBe('none');
  });

  it('drops a whitespace-only query but preserves meaningful inter-word spaces', () => {
    expect(applyIgContentFilters(new URLSearchParams(), { ...IG_CONTENT_DEFAULTS, q: '   ' }).has('q')).toBe(false);
    expect(applyIgContentFilters(new URLSearchParams(), { ...IG_CONTENT_DEFAULTS, q: 'product launch' }).get('q')).toBe(
      'product launch',
    );
  });
});

describe('secondary view (?more=) — default omitted, garbage normalised', () => {
  it('parses valid views; garbage/missing → default', () => {
    expect(parseIgSecondaryView('reels')).toBe('reels');
    expect(parseIgSecondaryView('stories')).toBe('stories');
    expect(parseIgSecondaryView('bogus')).toBe(IG_SECONDARY_DEFAULT);
    expect(parseIgSecondaryView(null)).toBe(IG_SECONDARY_DEFAULT);
  });

  it('serialise omits the default, keeps others, preserves unrelated params', () => {
    expect(applyIgSecondaryView(new URLSearchParams('campaign=1'), IG_SECONDARY_DEFAULT).has('more')).toBe(false);
    const next = applyIgSecondaryView(new URLSearchParams('campaign=1&q=x'), 'hashtags');
    expect(next.get('more')).toBe('hashtags');
    expect(next.get('campaign')).toBe('1');
    expect(next.get('q')).toBe('x');
  });
});

describe('classifyIgFormat — honest, mutually-exclusive buckets', () => {
  it('reels win over media_type', () => {
    expect(classifyIgFormat(post({ media_product_type: 'REELS', media_type: 'VIDEO' }))).toBe('reels');
    expect(classifyIgFormat(post({ media_product_type: 'REELS', media_type: 'CAROUSEL_ALBUM' }))).toBe('reels');
  });
  it('carousel / video / photo fallthrough', () => {
    expect(classifyIgFormat(post({ media_type: 'CAROUSEL_ALBUM' }))).toBe('carousel');
    expect(classifyIgFormat(post({ media_type: 'VIDEO' }))).toBe('video');
    expect(classifyIgFormat(post({ media_type: 'IMAGE' }))).toBe('photo');
    expect(classifyIgFormat(post({}))).toBe('photo');
  });
});

describe('igInteractions — honest total, null when nothing present', () => {
  it('prefers total_interactions', () => {
    expect(igInteractions(post({ total_interactions: 42, like_count: 1 }))).toBe(42);
  });
  it('falls back when Graph reports a stale zero total beside populated components', () => {
    expect(igInteractions(post({ total_interactions: 0, like_count: 10, comments_count: 2 }))).toBe(12);
    expect(igInteractions(post({ total_interactions: 0 }))).toBe(0);
  });
  it('falls back to the component sum', () => {
    expect(igInteractions(post({ like_count: 10, comments_count: 2, saved: 3, shares: 1 }))).toBe(16);
  });
  it('null only when NO component field is present', () => {
    expect(igInteractions(post({}))).toBeNull();
    expect(igInteractions(post({ saved: 0 }))).toBe(0);
  });
});

describe('igEr — matches interactions ÷ reach, honest null', () => {
  it('computes percent when reach > 0', () => {
    expect(igEr(post({ reach: 100, total_interactions: 10 }))).toBeCloseTo(10);
  });
  it('uses the same component fallback as the displayed interaction total', () => {
    const p = post({ reach: 100, total_interactions: 0, like_count: 8, comments_count: 2 });
    expect(igInteractions(p)).toBe(10);
    expect(igEr(p)).toBeCloseTo(10);
  });
  it('null when reach missing or ≤ 0 (never divide by zero)', () => {
    expect(igEr(post({ reach: 0, total_interactions: 10 }))).toBeNull();
    expect(igEr(post({ total_interactions: 10 }))).toBeNull();
  });
  it('null when interactions absent even if reach present', () => {
    expect(igEr(post({ reach: 100 }))).toBeNull();
  });
});

describe('matchesIgQuery — case-insensitive over caption + hashtags', () => {
  it('empty query matches everything', () => {
    expect(matchesIgQuery(post({ caption: 'anything' }), '')).toBe(true);
    expect(matchesIgQuery(post({ caption: 'anything' }), '   ')).toBe(true);
  });
  it('caption match is case-insensitive', () => {
    expect(matchesIgQuery(post({ caption: 'Большой Запуск' }), 'запуск')).toBe(true);
    expect(matchesIgQuery(post({ caption: 'nope' }), 'запуск')).toBe(false);
  });
  it('hashtag (from caption) match', () => {
    expect(matchesIgQuery(post({ caption: 'text #Sale #News' }), '#sale')).toBe(true);
    expect(matchesIgQuery(post({ caption: null }), 'sale')).toBe(false);
  });
});

describe('filterIgPosts — format + query compose', () => {
  const posts = [
    post({ id: '1', caption: 'launch video', media_type: 'VIDEO' }),
    post({ id: '2', caption: 'launch photo', media_type: 'IMAGE' }),
    post({ id: '3', caption: 'gallery', media_type: 'CAROUSEL_ALBUM' }),
    post({ id: '4', caption: 'reel drop', media_product_type: 'REELS', media_type: 'VIDEO' }),
  ];
  it('format all + empty query = pass-through', () => {
    expect(filterIgPosts(posts, { format: 'all', q: '' })).toHaveLength(4);
  });
  it('reels bucket excludes plain videos', () => {
    expect(filterIgPosts(posts, { format: 'reels', q: '' }).map((p) => p.id)).toEqual(['4']);
    expect(filterIgPosts(posts, { format: 'video', q: '' }).map((p) => p.id)).toEqual(['1']);
  });
  it('format + query intersect', () => {
    expect(filterIgPosts(posts, { format: 'video', q: 'launch' }).map((p) => p.id)).toEqual(['1']);
    expect(filterIgPosts(posts, { format: 'photo', q: 'launch' }).map((p) => p.id)).toEqual(['2']);
  });
});

describe('sortIgPosts — direction + null-last stability', () => {
  const posts = [
    post({ id: '1', reach: 100, saved: 2 }),
    post({ id: '2', reach: 300 }), // saved missing → null
    post({ id: '3', reach: 200, saved: 5 }),
  ];
  it('reach desc / asc', () => {
    expect(sortIgPosts(posts, 'reach', 'desc').map((p) => p.id)).toEqual(['2', '3', '1']);
    expect(sortIgPosts(posts, 'reach', 'asc').map((p) => p.id)).toEqual(['1', '3', '2']);
  });
  it('null metric sinks to the bottom in BOTH directions', () => {
    expect(sortIgPosts(posts, 'saved', 'desc').map((p) => p.id)).toEqual(['3', '1', '2']);
    expect(sortIgPosts(posts, 'saved', 'asc').map((p) => p.id)).toEqual(['1', '3', '2']);
  });
  it('date sort orders by timestamp', () => {
    const dated = [
      post({ id: '1', timestamp: '2026-07-01T00:00:00Z' }),
      post({ id: '2', timestamp: '2026-07-03T00:00:00Z' }),
      post({ id: '3', timestamp: '2026-07-02T00:00:00Z' }),
    ];
    expect(sortIgPosts(dated, 'date', 'desc').map((p) => p.id)).toEqual(['2', '3', '1']);
  });
  it('ties keep input order (stable) and input is not mutated', () => {
    const input = [post({ id: '1', reach: 5 }), post({ id: '2', reach: 5 }), post({ id: '3', reach: 5 })];
    expect(sortIgPosts(input, 'reach', 'desc').map((p) => p.id)).toEqual(['1', '2', '3']);
    expect(input.map((p) => p.id)).toEqual(['1', '2', '3']);
  });

  it('the no-sort state preserves the filtered input order via a non-mutating shallow copy', () => {
    // Input order is deliberately NOT the reach order — «none» must keep it exactly, in either «order».
    const input = [post({ id: '3', reach: 5 }), post({ id: '1', reach: 50 }), post({ id: '2', reach: 20 })];
    const out = sortIgPosts(input, 'none', 'desc');
    expect(out.map((p) => p.id)).toEqual(['3', '1', '2']);
    expect(sortIgPosts(input, 'none', 'asc').map((p) => p.id)).toEqual(['3', '1', '2']);
    expect(out).not.toBe(input); // shallow copy — never the same array reference
    expect(input.map((p) => p.id)).toEqual(['3', '1', '2']); // caller array untouched
  });
});

describe('median honesty gate — comparison needs ≥ 5 valid observations for that metric', () => {
  it('withholds a median below the min sample', () => {
    const four = [post({ reach: 1 }), post({ reach: 2 }), post({ reach: 3 }), post({ reach: 4 })];
    expect(periodMedian(four.map((p) => p.reach as number))).toBeNull();
  });
  it('computes a median at/above the min sample', () => {
    const five = [10, 20, 30, 40, 50].map((reach) => post({ reach }));
    expect(periodMedian(five.map((p) => p.reach as number))).toBe(30);
  });
  it('a metric that is mostly missing never reaches the gate — honest «—» instead', () => {
    // Only two posts carry `saved`; the metric-specific sample is 2 < 5, so no comparison.
    const posts = [post({ saved: 4 }), post({ saved: 6 }), post({}), post({}), post({})];
    const observed = posts.map((p) => p.saved).filter((v): v is number => v != null);
    expect(periodMedian(observed)).toBeNull();
  });
});
