import { describe, expect, it } from 'vitest';
import {
  MENTIONS_DEFAULTS,
  applyMentionsFilters,
  buildMentionsTimeline,
  capMentionsTimeline,
  filterMentionRows,
  mentionsDelta,
  mentionsInsights,
  parseMentionsFilters,
  sortMentionRows,
  type MentionDailyPoint,
  type MentionRow,
  type MentionSourceOption,
} from '@/lib/mentionsFilters';
import { fmt } from '@/lib/format';

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
    expect(t.labels[t.labels.length - 1]).toBe('14 июл.');
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
    expect(t.labels.at(-1)).toBe('15 июл.');
    expect(t.values.at(-1)).toBe(4);
  });

  it('all-time draws only days with data and no ghost', () => {
    const daily = [point('2026-05-01', 4), point('2026-06-15', 2)];
    const t = buildMentionsTimeline(daily, [], 0, now);
    expect(t.ghost).toBeUndefined();
    expect(t.values).toEqual([4, 2]);
    expect(t.labels).toEqual(['1 мая', '15 июн.']);
  });

  it('zero-fills a custom range to exactly its inclusive day count', () => {
    // 5-day inclusive window [10..14 июня]; range wins over the days arg (passed 0 here).
    const daily = [point('2026-06-10', 3), point('2026-06-14', 5)];
    const t = buildMentionsTimeline(daily, [], 0, '2026-06-14', { from: '2026-06-10', to: '2026-06-14' });
    expect(t.values).toEqual([3, 0, 0, 0, 5]);
    expect(t.labels).toEqual(['10 июн.', '11 июн.', '12 июн.', '13 июн.', '14 июн.']);
  });

  it('aligns a custom-range ghost to the preceding equal-length window', () => {
    // Window [10..12] (3 days); previous window is [07..09]. Ordinal-first of previous → 07.06.
    const daily = [point('2026-06-10', 4)];
    const previous = [point('2026-06-07', 9)];
    const t = buildMentionsTimeline(daily, previous, 0, '2026-06-12', { from: '2026-06-10', to: '2026-06-12' });
    expect(t.values).toEqual([4, 0, 0]);
    expect(t.ghost).toEqual([9, 0, 0]);
  });

  it('treats a single-day custom range as one bar', () => {
    const daily = [point('2026-06-10', 7)];
    const t = buildMentionsTimeline(daily, [], 0, '2026-06-10', { from: '2026-06-10', to: '2026-06-10' });
    expect(t.values).toEqual([7]);
    expect(t.labels).toEqual(['10 июн.']);
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

describe('таймлайн упоминаний — канон подписи даты (U5)', () => {
  it('подписи и тултипы идут единым «13 июл.», а не dd.mm', () => {
    const daily: MentionDailyPoint[] = [{ day: '2026-07-09', mentions: 3, views: 300, channels: 1 }];
    const t = buildMentionsTimeline(daily, [], 7, '2026-07-09');
    expect(t.labels.at(-1)).toBe('9 июл.');
    expect(t.titles.at(-1)).toContain('9 июл.:');
    expect(t.labels.some((l) => /^\d{2}\.\d{2}$/.test(l))).toBe(false);
  });
});

describe('capMentionsTimeline', () => {
  /** Плотное окно из n дней, заканчивающееся 2026-07-27, с ghost'ом той же длины. */
  const denseTimeline = (n: number) => {
    const days: string[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(2026, 6, 27));
      d.setUTCDate(d.getUTCDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    return {
      values: days.map((_, i) => (i % 3 === 0 ? 2 : i % 5 === 0 ? 1 : 0)),
      ghost: days.map((_, i) => (i % 4 === 0 ? 1 : 0)),
      labels: days.map((d) => fmt.day(d)),
      titles: days.map((d) => `${fmt.day(d)}: t`),
      days,
      views: days.map((_, i) => i),
    };
  };

  it('is a no-op for short windows (7/30/90 stay daily)', () => {
    const t = denseTimeline(90);
    expect(capMentionsTimeline(t, 'bar')).toBe(t);
    expect(capMentionsTimeline(t, 'line')).toBe(t);
  });

  it('bar: collapses a 365-day window into ≤53 weekly buckets with aligned ghost and honest labels', () => {
    const t = denseTimeline(365);
    const capped = capMentionsTimeline(t, 'bar');
    expect(capped.values.length).toBeLessThanOrEqual(53);
    expect(capped.values.length).toBeGreaterThan(40);
    expect(capped.ghost).toHaveLength(capped.values.length);
    expect(capped.labels).toHaveLength(capped.values.length);
    // Суммы сохраняются: недельные корзины — перегруппировка, не потеря.
    const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
    expect(sum(capped.values)).toBe(sum(t.values));
    expect(sum(capped.ghost!)).toBe(sum(t.ghost));
    expect(sum(capped.views)).toBe(sum(t.views));
    // Тултип обязан нести маркер недели (честность подписи).
    expect(capped.titles[0]).toContain('неделя');
  });

  it('line: with a ghost picks THE SAME indexes for both series', () => {
    const t = denseTimeline(365);
    const capped = capMentionsTimeline(t, 'line');
    expect(capped.values.length).toBeLessThanOrEqual(140);
    expect(capped.ghost).toHaveLength(capped.values.length);
    // Первая/последняя точки сохраняются, пары (value, ghost) остаются исходными парами.
    expect(capped.values[0]).toBe(t.values[0]);
    expect(capped.values.at(-1)).toBe(t.values.at(-1));
    capped.days.forEach((day, i) => {
      const orig = t.days.indexOf(day);
      expect(orig).toBeGreaterThanOrEqual(0);
      expect(capped.values[i]).toBe(t.values[orig]);
      expect(capped.ghost![i]).toBe(t.ghost[orig]);
    });
  });

  it('line: without a ghost falls back to LTTB and keeps endpoints', () => {
    const t = { ...denseTimeline(365), ghost: undefined };
    const capped = capMentionsTimeline(t, 'line');
    expect(capped.values.length).toBeLessThanOrEqual(140);
    expect(capped.ghost).toBeUndefined();
    expect(capped.days[0]).toBe(t.days[0]);
    expect(capped.days.at(-1)).toBe(t.days.at(-1));
  });
});
