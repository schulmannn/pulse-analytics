import { describe, expect, it } from 'vitest';
import {
  MENTIONS_DEFAULTS,
  applyMentionsFilters,
  buildMentionsTimeline,
  ddmmFromIso,
  filterMentionRows,
  mentionsDelta,
  mentionsInsights,
  parseMentionsFilters,
  sortMentionRows,
  type MentionDailyPoint,
  type MentionRow,
  type MentionSourceOption,
} from '@/lib/mentionsFilters';

const q = (s: string) => new URLSearchParams(s);

describe('parseMentionsFilters', () => {
  it('returns defaults for an empty query', () => {
    expect(parseMentionsFilters(q(''))).toEqual(MENTIONS_DEFAULTS);
  });

  it('parses valid params', () => {
    expect(parseMentionsFilters(q('period=90&source=12345&q=бренд&sort=views&order=asc'))).toEqual({
      period: 90,
      source: '12345',
      q: 'бренд',
      sort: 'views',
      order: 'asc',
    });
  });

  it('period=all → 0, unknown → default 30', () => {
    expect(parseMentionsFilters(q('period=all')).period).toBe(0);
    expect(parseMentionsFilters(q('period=999')).period).toBe(30);
  });

  it('normalises a garbage source to empty and strips leading zeros', () => {
    expect(parseMentionsFilters(q('source=abc')).source).toBe('');
    expect(parseMentionsFilters(q('source=-5')).source).toBe('');
    expect(parseMentionsFilters(q('source=007')).source).toBe('7');
    expect(parseMentionsFilters(q('source=0')).source).toBe('');
    expect(parseMentionsFilters(q('source=000')).source).toBe('');
  });

  it('clears an invalid sort/order to defaults', () => {
    const f = parseMentionsFilters(q('sort=bogus&order=sideways'));
    expect(f.sort).toBe('date');
    expect(f.order).toBe('desc');
  });
});

describe('applyMentionsFilters', () => {
  it('omits every default from the URL', () => {
    expect(applyMentionsFilters(q(''), MENTIONS_DEFAULTS).toString()).toBe('');
  });

  it('serialises non-defaults and preserves unrelated params', () => {
    const next = applyMentionsFilters(q('view=x'), {
      period: 7,
      source: '42',
      q: 'hi',
      sort: 'views',
      order: 'asc',
    });
    expect(next.get('view')).toBe('x');
    expect(next.get('period')).toBe('7');
    expect(next.get('source')).toBe('42');
    expect(next.get('q')).toBe('hi');
    expect(next.get('sort')).toBe('views');
    expect(next.get('order')).toBe('asc');
  });

  it('round-trips through parse', () => {
    const f = { period: 90 as const, source: '99', q: 'launch', sort: 'source' as const, order: 'asc' as const };
    expect(parseMentionsFilters(applyMentionsFilters(q(''), f))).toEqual(f);
  });
});

describe('buildMentionsTimeline', () => {
  const now = Date.parse('2026-07-14T12:00:00Z');
  const point = (day: string, mentions: number, views = mentions * 100): MentionDailyPoint => ({
    day,
    mentions,
    views,
    channels: 1,
  });

  it('zero-fills a 7-day window to exactly 7 bars ending today', () => {
    const daily = [point('2026-07-14', 3), point('2026-07-12', 1)];
    const t = buildMentionsTimeline(daily, [], 7, now);
    expect(t.values).toHaveLength(7);
    // last bar is today (14th) = 3, the 12th = 1, the rest zeros
    expect(t.values[t.values.length - 1]).toBe(3);
    expect(t.values[4]).toBe(1); // index 4 = 12th (14 - (6-4))
    expect(t.labels[t.labels.length - 1]).toBe('14.07');
  });

  it('aligns the ghost to the previous equal window by ordinal day', () => {
    const daily = [point('2026-07-14', 5)];
    const previous = [point('2026-07-07', 2)]; // 7 days before → ordinal-last of previous window
    const t = buildMentionsTimeline(daily, previous, 7, now);
    expect(t.ghost).toHaveLength(7);
    expect(t.ghost?.[t.ghost.length - 1]).toBe(2);
    expect(t.values[t.values.length - 1]).toBe(5);
  });

  it('uses the server calendar anchor instead of the browser timezone date', () => {
    const daily = [point('2026-07-15', 4)];
    const t = buildMentionsTimeline(daily, [], 7, '2026-07-15');
    expect(t.labels.at(-1)).toBe('15.07');
    expect(t.values.at(-1)).toBe(4);
  });

  it('all-time draws only days with data and no ghost', () => {
    const daily = [point('2026-05-01', 4), point('2026-06-15', 2)];
    const t = buildMentionsTimeline(daily, [], 0, now);
    expect(t.ghost).toBeUndefined();
    expect(t.values).toEqual([4, 2]);
    expect(t.labels).toEqual(['01.05', '15.06']);
  });
});

describe('mentionsDelta', () => {
  it('is null with no previous period (all-time)', () => {
    expect(mentionsDelta(10, null)).toBeNull();
  });
  it('reports «нет базы» when previous is zero', () => {
    expect(mentionsDelta(5, 0)).toEqual({ pct: null, hasBase: false });
  });
  it('computes a percentage against a real base', () => {
    expect(mentionsDelta(12, 10)).toEqual({ pct: 20, hasBase: true });
  });
});

describe('mentionsInsights', () => {
  const daily: MentionDailyPoint[] = [
    { day: '2026-07-10', mentions: 2, views: 200, channels: 1 },
    { day: '2026-07-12', mentions: 5, views: 900, channels: 2 },
  ];
  const sources: MentionSourceOption[] = [
    { channel_id: '1', username: 'smm', title: 'SMM', count: 4, views: 700 },
    { channel_id: '2', username: null, title: 'Blog', count: 3, views: 400 },
  ];

  it('derives peak day, top-source label and concentration shares', () => {
    const i = mentionsInsights(daily, sources, 7, 1100);
    expect(i.peak).toEqual({ day: '2026-07-12', mentions: 5 });
    expect(i.topSourceLabel).toBe('@smm');
    expect(i.topSourceMentionShare).toBeCloseTo(4 / 7);
    expect(i.topSourceViewShare).toBeCloseTo(700 / 1100);
  });

  it('uses the latest day when several days share the same peak', () => {
    const tied = [
      { day: '2026-07-10', mentions: 5, views: 100, channels: 1 },
      { day: '2026-07-12', mentions: 5, views: 100, channels: 1 },
    ];
    expect(mentionsInsights(tied, sources, 10, 200).peak?.day).toBe('2026-07-12');
  });

  it('is empty when there is no data', () => {
    const i = mentionsInsights([], [], 0, 0);
    expect(i.peak).toBeNull();
    expect(i.topSourceLabel).toBeNull();
    expect(i.topSourceMentionShare).toBeNull();
  });
});

describe('table filter/sort', () => {
  const rows: MentionRow[] = [
    { title: 'SMM Daily', username: 'smm', snippet: 'про бренд', views: 300, date: '2026-07-10T00:00:00Z' },
    { title: 'Marketing', username: 'mkt', snippet: 'другое', views: 900, date: '2026-07-12T00:00:00Z' },
    { title: 'Notes', username: 'note', snippet: null, views: null, date: null },
  ];

  it('filters q over title/username/snippet, case-insensitively', () => {
    expect(filterMentionRows(rows, 'бренд').map((r) => r.username)).toEqual(['smm']);
    expect(filterMentionRows(rows, 'MKT').map((r) => r.username)).toEqual(['mkt']);
    expect(filterMentionRows(rows, '')).toHaveLength(3);
  });

  it('sorts by views desc with nulls last', () => {
    expect(sortMentionRows(rows, 'views', 'desc').map((r) => r.views)).toEqual([900, 300, null]);
  });

  it('sorts by date asc with nulls last', () => {
    expect(sortMentionRows(rows, 'date', 'asc').map((r) => r.username)).toEqual(['smm', 'mkt', 'note']);
  });

  it('sorts by source name', () => {
    expect(sortMentionRows(rows, 'source', 'asc').map((r) => r.username)).toEqual(['mkt', 'note', 'smm']);
  });

  it('keeps a missing source at the bottom in either direction', () => {
    const withMissing = [...rows, { title: null, username: null, views: 1 }];
    expect(sortMentionRows(withMissing, 'source', 'asc').at(-1)?.title).toBeNull();
    expect(sortMentionRows(withMissing, 'source', 'desc').at(-1)?.title).toBeNull();
  });
});

describe('ddmmFromIso', () => {
  it('formats an ISO day', () => {
    expect(ddmmFromIso('2026-07-09')).toBe('09.07');
  });
});
