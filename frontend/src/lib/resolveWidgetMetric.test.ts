import { describe, expect, it } from 'vitest';
import { pluralRu, resolveWidgetMetric, type DataContext } from '@/lib/resolveWidgetMetric';
import type { WidgetConfig } from '@/lib/widgetConfig';
import { WIDGET_METRICS } from '@/lib/widgetMetrics';
import type {
  ChannelsResponse,
  HistoryData,
  IgBreakdowns,
  IgHistoryData,
  IgInsights,
  IgOnline,
  IgProfile,
  TgFull,
  TgGraphs,
} from '@/api/schemas';

// ── Deterministic synthetic fixtures around a fixed «now» (no Date.now() in the resolver). ──
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-15T12:00:00Z');
const WIN_TO = NOW;
const WIN_FROM = NOW - 29 * DAY; // 30-day preset window
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

const inRange = (d: string | null | undefined) => {
  if (!d) return false;
  const t = Date.parse(d);
  return Number.isFinite(t) && t >= WIN_FROM && t <= WIN_TO;
};

const mkPost = (
  daysAgo: number,
  views: number,
  reactions = 0,
  forwards = 0,
  replies = 0,
  reactions_detail?: { emoji: string; count: number }[],
) => ({
  id: Math.round(daysAgo),
  date: iso(daysAgo),
  views,
  reactions,
  forwards,
  replies,
  media_type: 'photo',
  reactions_detail,
});

const full = {
  channel: { memberCount: 44000, username: 'bynotem' },
  views_summary: {
    total_reactions: 175,
    total_forwards: 35,
    total_replies: 13,
    avg_views_by_type: { photo: 1200, video: 800 },
  },
  posts: [
    mkPost(1, 1000, 50, 10, 5, [{ emoji: '🔥', count: 30 }, { emoji: '👍', count: 20 }]),
    mkPost(5, 2000, 100, 20, 8),
    mkPost(10, 500, 25, 5, 2),
    mkPost(35, 800, 40, 8, 3), // OUTSIDE the active window — only feeds the baseline (ghost)
  ],
} as unknown as TgFull;

const graphs = {
  views_by_source: [
    { label: 'Followers', value: 5000 },
    { label: 'URL', value: 2000 },
  ],
  new_followers_by_source: [{ label: 'Search', value: 120 }],
  languages: [
    { label: 'ru', value: 8000 },
    { label: 'en', value: 1500 },
  ],
  reactions_sentiment: [
    { label: 'Positive', value: 300 },
    { label: 'Negative', value: 40 },
  ],
  top_hours: { hours: [9, 12, 18], values: [100, 250, 400] },
  followers: {
    x: [1, 2, 3],
    series: [
      { name: 'joined', values: [10, 20, 30] },
      { name: 'left', values: [3, 5, 7] },
    ],
  },
} as unknown as TgGraphs;

const history = {
  rows: [
    { day: '2026-06-10', subscribers: 43900, views: 3000, reactions: 150, forwards: 30 },
    { day: '2026-06-14', subscribers: 44000, views: 3500, reactions: 175, forwards: 35 },
  ],
} as unknown as HistoryData;

const channels = { channels: [{ id: 1, memberCount: 44000, username: 'bynotem' }] } as unknown as ChannelsResponse;

const ctx: DataContext = {
  now: NOW,
  days: 30,
  range: null,
  inRange,
  tg: { full, history, channels, graphs, channelId: 1 },
};

const cfg = (metricId: string, extra: Partial<WidgetConfig> = {}): WidgetConfig => ({
  id: 'w',
  metricId,
  viz: 'line',
  ...extra,
});

describe('resolveWidgetMetric — TG core series', () => {
  it('resolves tg.views: value, valueRaw (sum of reach), full-window series', () => {
    const r = resolveWidgetMetric(cfg('tg.views'), ctx);
    expect(r.empty).toBeFalsy();
    expect(r.kind).toBe('series');
    expect(r.unit).toBe('views');
    expect(r.value).toBeTruthy();
    expect(r.valueRaw).toBe(3500); // 1000 + 2000 + 500 (the 35-day post is out of window)
    expect(r.series).toBeDefined();
    expect(r.series!.length).toBe(30); // 30 day-buckets across the window
    const sum = r.series!.reduce((s, p) => s + p.value, 0);
    expect(sum).toBe(3500); // series reconciles with the headline sum
    // bucket keys are raw YYYY-MM-DD, not formatted labels
    expect(r.series!.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date))).toBe(true);
  });

  it('adds an aligned ghost series for previous_period comparison', () => {
    const r = resolveWidgetMetric(cfg('tg.views', { comparison: { mode: 'previous_period', display: 'ghost_line' } }), ctx);
    expect(r.ghost).toBeDefined();
    expect(r.ghost!.length).toBe(r.series!.length); // aligned to the active series
    expect(r.ghost!.some((v) => v > 0)).toBe(true); // the 35-day post lands in the baseline
    expect(r.ghostLabel).toBe('прошлый период');
  });

  it('suppresses the ghost when the fetch is capped and the baseline predates the loaded posts', () => {
    // 100 posts (>= the 100-post server cap → "capped") spanning only days 1..40. For a 30d window
    // the previous_period baseline is days ~30..59 — the loaded posts reach only day 40, so days
    // 40..59 are unloaded and a per-post sum undercounts. The coverage guard suppresses the ghost
    // (without it, the days 30..40 posts would draw a misleading near-zero baseline line).
    const many = Array.from({ length: 100 }, (_, i) => mkPost(1 + (i % 40), 500, 20, 4, 2));
    const cappedCtx: DataContext = {
      ...ctx,
      tg: { ...ctx.tg!, full: { ...(full as object), posts: many } as unknown as TgFull },
    };
    const r = resolveWidgetMetric(cfg('tg.views', { comparison: { mode: 'previous_period', display: 'ghost_line' } }), cappedCtx);
    expect(r.ghost).toBeUndefined();
  });

  it('omits the ghost when no comparison is configured', () => {
    const r = resolveWidgetMetric(cfg('tg.views'), ctx);
    expect(r.ghost).toBeUndefined();
    expect(r.ghostLabel).toBeUndefined();
  });

  it('honours the comparison display: «delta» draws no ghost line (S8)', () => {
    const line = resolveWidgetMetric(cfg('tg.views', { comparison: { mode: 'previous_period', display: 'ghost_line' } }), ctx);
    expect(line.ghost).toBeDefined();
    const deltaOnly = resolveWidgetMetric(cfg('tg.views', { comparison: { mode: 'previous_period', display: 'delta' } }), ctx);
    expect(deltaOnly.ghost).toBeUndefined(); // «Дельта» is a real choice, not a no-op
  });

  it('supports the same_period_last_month baseline (S8)', () => {
    const r = resolveWidgetMetric(cfg('tg.views', { comparison: { mode: 'same_period_last_month', display: 'ghost_line' } }), ctx);
    expect(r.ghost).toBeDefined();
    expect(r.ghostLabel).toBe('прошлый месяц');
  });

  it('resolves tg.subscribers from the daily archive (level series, last-of-bucket)', () => {
    const r = resolveWidgetMetric(cfg('tg.subscribers'), ctx);
    expect(r.empty).toBeFalsy();
    expect(r.unit).toBe('number');
    expect(r.valueRaw).toBe(44000); // displayMembers from the channels list
    expect(r.series!.map((p) => p.value)).toEqual([43900, 44000]);
  });

  it('buckets a flow metric by quarter — one bucket summing the whole window (S10)', () => {
    const r = resolveWidgetMetric(cfg('tg.views', { grain: 'quarter' }), ctx);
    // The 30-day window (May 17 → Jun 15 2026) is entirely within Q2 2026 → one bucket.
    expect(r.series).toEqual([{ date: '2026-Q2', value: 3500 }]);
  });

  it('buckets a LEVEL metric by year — last value in the bucket, not a sum (S10)', () => {
    const r = resolveWidgetMetric(cfg('tg.subscribers', { grain: 'year' }), ctx);
    // Both archive rows are in 2026 → one year bucket holding the LAST subscriber count (44000),
    // never their sum (which would be nonsense for a stock metric).
    expect(r.series).toEqual([{ date: '2026', value: 44000 }]);
  });
});

describe('resolveWidgetMetric — target / progress (S9)', () => {
  it('a fixed target sets result.target + «% of target» progress', () => {
    const r = resolveWidgetMetric(cfg('tg.views', { target: { type: 'fixed', value: 7000 } }), ctx);
    expect(r.target).toBe(7000);
    expect(r.targetPct).toBeCloseTo(50, 5); // 3500 / 7000
  });

  it('a dynamic target resolves another metric’s current value', () => {
    // target = tg.reactions (valueRaw = 50+100+25 = 175 likes in window)
    const r = resolveWidgetMetric(cfg('tg.views', { target: { type: 'dynamic', metricId: 'tg.reactions' } }), ctx);
    expect(r.target).toBe(175);
    expect(r.targetPct).toBeCloseTo((3500 / 175) * 100, 3);
  });

  it('ignores a self-referential dynamic target and an unusable fixed value', () => {
    expect(resolveWidgetMetric(cfg('tg.views', { target: { type: 'dynamic', metricId: 'tg.views' } }), ctx).target).toBeUndefined();
    expect(resolveWidgetMetric(cfg('tg.views', { target: { type: 'fixed', value: 0 } }), ctx).target).toBeUndefined();
  });

  it('no target → no target/progress fields', () => {
    const r = resolveWidgetMetric(cfg('tg.views'), ctx);
    expect(r.target).toBeUndefined();
    expect(r.targetPct).toBeUndefined();
  });
});

describe('resolveWidgetMetric — TG ratio values', () => {
  it('resolves tg.erv as an average percentage of the in-window posts', () => {
    const r = resolveWidgetMetric(cfg('tg.erv'), ctx);
    expect(r.empty).toBeFalsy();
    expect(r.kind).toBe('value');
    expect(r.unit).toBe('percent');
    expect(r.value).toMatch(/%$/);
    expect(r.valueRaw).toBeGreaterThan(0);
    expect(Number.isFinite(r.valueRaw!)).toBe(true);
  });

  it('resolves tg.virality similarly', () => {
    const r = resolveWidgetMetric(cfg('tg.virality'), ctx);
    expect(r.value).toMatch(/%$/);
    expect(r.valueRaw).toBeGreaterThan(0);
  });
});

describe('resolveWidgetMetric — TG breakdowns (S3b)', () => {
  const bd = (metricId: string) => resolveWidgetMetric(cfg(metricId), ctx);

  it('resolves tg.emoji from in-window post reactions (top emoji first)', () => {
    const r = bd('tg.emoji');
    expect(r.kind).toBe('breakdown');
    expect(r.breakdown).toEqual([
      { label: '🔥', value: 30, display: '30' },
      { label: '👍', value: 20, display: '20' },
    ]);
  });

  it('resolves tg.formatPerf as avg ERV per media type', () => {
    const r = bd('tg.formatPerf');
    expect(r.breakdown!.length).toBeGreaterThan(0);
    expect(r.breakdown!.every((i) => i.value > 0)).toBe(true);
    expect(r.breakdown![0].display).toMatch(/% ERV · \d+ пост(а|ов)?$/);
  });

  it('resolves tg.engagementComposition + tg.viewsByType from views_summary', () => {
    expect(bd('tg.engagementComposition').breakdown!.map((i) => i.label)).toEqual(['Реакции', 'Репосты', 'Комментарии']);
    expect(bd('tg.viewsByType').breakdown!.map((i) => i.label)).toEqual(['Фото', 'Видео']); // sorted desc by value
  });

  it('resolves graphs breakdowns with localized labels', () => {
    expect(bd('tg.viewsBySource').breakdown!.map((i) => i.label)).toEqual(['Подписчики', 'Ссылки']);
    expect(bd('tg.newFollowersBySource').breakdown!.map((i) => i.label)).toEqual(['Поиск']);
    expect(bd('tg.languages').breakdown!.map((i) => i.label)).toEqual(['ru', 'en']);
  });

  it('resolves tg.sentiment with sentiment colors', () => {
    const r = bd('tg.sentiment');
    expect(r.breakdown!.map((i) => i.label)).toEqual(['Положительные', 'Отрицательные']);
    expect(r.breakdown![0].color).toBe('hsl(var(--brand-verdant))');
  });

  it('additive breakdowns get a headline total hero (#4.9); averages/percentages do not', () => {
    // Complete count categories → sum is a meaningful total the card leads with.
    expect(bd('tg.engagementComposition').valueRaw).toBe(223); // 175 + 35 + 13
    expect(bd('tg.engagementComposition').value).toBeTruthy();
    expect(bd('tg.viewsBySource').valueRaw).toBe(7000); // 5000 + 2000
    expect(bd('tg.sentiment').valueRaw).toBe(340); // 300 + 40
    // Averages / percentages → a sum is nonsense → left heroless (leads with the chart).
    expect(bd('tg.viewsByType').value).toBeUndefined(); // avg reach per type
    expect(bd('tg.viewsByType').valueRaw).toBeUndefined();
    expect(bd('tg.formatPerf').value).toBeUndefined(); // percent ERV per format
  });

  it('resolves tg.hours by hour of day', () => {
    const r = bd('tg.hours');
    expect(r.breakdown!.map((i) => i.label)).toEqual(['9:00', '12:00', '18:00']);
    expect(r.breakdown!.map((i) => i.value)).toEqual([100, 250, 400]);
  });

  it('resolves tg.churn joined vs left totals', () => {
    const r = bd('tg.churn');
    expect(r.breakdown).toEqual([
      { label: 'Подписалось', value: 60, display: '60', color: 'hsl(var(--brand-verdant))' },
      { label: 'Отписалось', value: 15, display: '15', color: 'hsl(var(--brand-ember))' },
    ]);
  });

  it('treats an all-zero weekday breakdown (no posts) as empty', () => {
    const emptyPosts: DataContext = { ...ctx, tg: { ...ctx.tg!, full: { ...(full as object), posts: [] } as unknown as TgFull } };
    expect(resolveWidgetMetric(cfg('tg.postCount'), emptyPosts).empty).toBe(true);
    expect(resolveWidgetMetric(cfg('tg.weekdayViews'), emptyPosts).empty).toBe(true);
  });

  it('returns empty when graphs are absent', () => {
    const noGraphs: DataContext = { ...ctx, tg: { ...ctx.tg!, graphs: undefined } };
    expect(resolveWidgetMetric(cfg('tg.languages'), noGraphs).empty).toBe(true);
  });
});

describe('resolveWidgetMetric — per-post filters (S7)', () => {
  const mixedFull = {
    channel: { memberCount: 44000, username: 'bynotem' },
    posts: [
      mkPost(1, 1000), // photo (mkPost default media_type)
      { ...mkPost(2, 3000), media_type: 'video' },
      { ...mkPost(3, 500), media_type: 'video' },
    ],
  } as unknown as TgFull;
  const mixedCtx: DataContext = { ...ctx, tg: { ...ctx.tg!, full: mixedFull } };

  it('filters a series metric (tg.views) to a single format', () => {
    const r = resolveWidgetMetric(
      cfg('tg.views', { filters: [{ dimensionId: 'tg.format', op: 'in', values: ['Видео'] }] }),
      mixedCtx,
    );
    expect(r.valueRaw).toBe(3500); // 3000 + 500 video; the 1000 photo is excluded
  });

  it('filters a breakdown metric (tg.postCount) to a single format', () => {
    const r = resolveWidgetMetric(
      cfg('tg.postCount', { filters: [{ dimensionId: 'tg.format', op: 'in', values: ['Фото'] }] }),
      mixedCtx,
    );
    expect(r.breakdown!.reduce((s, i) => s + i.value, 0)).toBe(1); // only the single photo post
  });

  it('no filters counts every post', () => {
    expect(resolveWidgetMetric(cfg('tg.views'), mixedCtx).valueRaw).toBe(4500);
  });

  // The KPI trend for views/reactions/forwards is archive-derived (whole-channel). With a filter it
  // must NOT sit beside a filtered headline — recompute from filtered post windows, or suppress.
  // deriveKpis' window math keys off Date.now(), so this test dates posts/archive relative to now.
  it('does not show the whole-channel delta beside a filtered core KPI (suppress/recompute)', () => {
    const now = Date.now();
    const dISO = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();
    const full = {
      channel: { memberCount: 1000, username: 'x' },
      posts: [
        { id: 1, date: dISO(5), views: 1000, media_type: 'video' }, // current window, video
        { id: 2, date: dISO(6), views: 2000, media_type: 'photo' }, // current window, photo
        { id: 3, date: dISO(40), views: 5000, media_type: 'photo' }, // previous window, photo
        { id: 4, date: dISO(65), views: 100, media_type: 'photo' }, // older → windowTotals non-null
      ],
    } as unknown as TgFull;
    const history = { rows: [{ day: dISO(40), views: 5000 }, { day: dISO(5), views: 3000 }] } as unknown as HistoryData;
    const inRangeNow = (i: string | null | undefined) => {
      if (!i) return false;
      const t = Date.parse(i);
      return Number.isFinite(t) && t >= now - 30 * DAY && t <= now;
    };
    const c: DataContext = { now, days: 30, range: null, inRange: inRangeNow, tg: { full, history, channels, channelId: 1 } };

    const unfiltered = resolveWidgetMetric(cfg('tg.views'), c);
    expect(unfiltered.delta).toBeTruthy(); // whole-channel archive trend is non-null here

    const filtered = resolveWidgetMetric(cfg('tg.views', { filters: [{ dimensionId: 'tg.format', op: 'in', values: ['Видео'] }] }), c);
    expect(filtered.valueRaw).toBe(1000); // only the single in-window video
    // No paired video window (no video in the previous 30d) → the stale whole-channel delta is
    // suppressed, not shown beside the filtered «1000».
    expect(filtered.delta ?? null).toBeNull();
  });
});

describe('resolveWidgetMetric — tg.netGrowth (S3c series-from-graphs)', () => {
  // followers graph x = ms timestamps within the window; joined/left → net daily = joined − left.
  const netGraphs = {
    followers: {
      x: [NOW - 2 * DAY, NOW - 1 * DAY],
      series: [
        { name: 'joined', values: [30, 40] },
        { name: 'left', values: [10, 5] },
      ],
    },
  } as unknown as TgGraphs;
  const netCtx: DataContext = { ...ctx, tg: { ...ctx.tg!, graphs: netGraphs } };

  it('resolves net growth as a flow series summing joined − left', () => {
    const r = resolveWidgetMetric(cfg('tg.netGrowth'), netCtx);
    expect(r.empty).toBeFalsy();
    expect(r.kind).toBe('series');
    expect(r.valueRaw).toBe(55); // (30−10) + (40−5)
    expect(r.value).toBe('+55');
    expect(r.series!.reduce((s, p) => s + p.value, 0)).toBe(55);
  });

  it('returns empty when the followers graph is absent', () => {
    const noFollowers: DataContext = { ...ctx, tg: { ...ctx.tg!, graphs: {} as unknown as TgGraphs } };
    expect(resolveWidgetMetric(cfg('tg.netGrowth'), noFollowers).empty).toBe(true);
  });
});

describe('resolveWidgetMetric — stubs + guards (never throws)', () => {
  it('dispatches every catalogue metric through an explicit resolver strategy', () => {
    const emptyContext: DataContext = { now: NOW, days: 30, range: null, inRange };
    for (const metric of WIDGET_METRICS) {
      const result = resolveWidgetMetric(cfg(metric.id, { viz: metric.defaultViz }), emptyContext);
      expect(result.metricId, metric.id).toBe(metric.id);
      expect(result.kind, metric.id).toBe(metric.kind);
      expect(result.unit, metric.id).toBe(metric.unit);
      expect(result.empty, metric.id).toBe(true);
    }
  });

  it('returns empty for an unknown metric', () => {
    expect(resolveWidgetMetric(cfg('nope.metric'), ctx).empty).toBe(true);
  });

  it('returns empty for IG metrics when the ctx carries no IG payload', () => {
    expect(resolveWidgetMetric(cfg('ig.reach'), ctx).empty).toBe(true); // ctx.ig is undefined
  });

  it('returns empty for TG series-from-graphs / tables (S3c not wired yet)', () => {
    expect(resolveWidgetMetric(cfg('tg.netGrowth'), ctx).empty).toBe(true);
    expect(resolveWidgetMetric(cfg('tg.weeklyTable'), ctx).empty).toBe(true);
    expect(resolveWidgetMetric(cfg('tg.topPosts'), ctx).empty).toBe(true);
  });

  it('returns empty when the TG payload is missing rather than crashing', () => {
    const noData: DataContext = { ...ctx, tg: { channelId: null } };
    expect(resolveWidgetMetric(cfg('tg.views'), noData).empty).toBe(true);
    expect(resolveWidgetMetric(cfg('tg.erv'), noData).empty).toBe(true);
  });
});

// ── Instagram (S11) ────────────────────────────────────────────────────────────────────────────
const igInsights = {
  data: [
    { name: 'reach', values: [{ end_time: iso(1), value: 1000 }, { end_time: iso(5), value: 2000 }, { end_time: iso(35), value: 500 }] },
    { name: 'total_interactions', values: [{ end_time: iso(1), value: 100 }, { end_time: iso(5), value: 200 }] },
    { name: 'follows', values: [{ end_time: iso(2), value: 50 }] },
    { name: 'unfollows', values: [{ end_time: iso(2), value: 10 }] },
  ],
} as unknown as IgInsights;

const igBreakdowns = {
  data: [
    {
      name: 'total_interactions',
      total_value: {
        breakdowns: [
          {
            dimension_keys: ['media_product_type'],
            results: [
              { dimension_values: ['REEL'], value: 300 },
              { dimension_values: ['FEED'], value: 200 },
            ],
          },
        ],
      },
    },
    {
      name: 'follower_demographics',
      total_value: {
        breakdowns: [
          { dimension_keys: ['age'], results: [{ dimension_values: ['25-34'], value: 800 }, { dimension_values: ['18-24'], value: 500 }] },
          { dimension_keys: ['gender'], results: [{ dimension_values: ['F'], value: 700 }, { dimension_values: ['M'], value: 600 }] },
          { dimension_keys: ['country'], results: [{ dimension_values: ['RU'], value: 900 }] },
          { dimension_keys: ['city'], results: [{ dimension_values: ['Moscow, Moscow'], value: 400 }] },
        ],
      },
    },
  ],
} as unknown as IgBreakdowns;

const igProfile = { followers_count: 44000 } as unknown as IgProfile;
const igOnline = { data: [{ values: [{ end_time: iso(3), value: { '9': 10, '12': 25, '18': 40 } }] }] } as unknown as IgOnline;

const igCtx: DataContext = {
  now: NOW,
  days: 30,
  range: null,
  inRange,
  ig: { profile: igProfile, insights: igInsights, breakdowns: igBreakdowns, online: igOnline },
};

describe('resolveWidgetMetric — Instagram (S11)', () => {
  it('resolves ig.reach as a flow series (sum) + value + delta', () => {
    const r = resolveWidgetMetric(cfg('ig.reach'), igCtx);
    expect(r.empty).toBeFalsy();
    expect(r.kind).toBe('series');
    expect(r.unit).toBe('views');
    expect(r.valueRaw).toBe(3000); // 1000 + 2000 in window
    expect(r.series!.reduce((s, p) => s + p.value, 0)).toBe(3000);
  });

  it('wires the comparison ghost for IG series (S8) + honours «delta»', () => {
    const line = resolveWidgetMetric(cfg('ig.reach', { comparison: { mode: 'previous_period', display: 'ghost_line' } }), igCtx);
    expect(line.ghost).toBeDefined(); // the 35-day reach point lands in the baseline window
    expect(line.ghostLabel).toBe('прошлый период');
    const deltaOnly = resolveWidgetMetric(cfg('ig.reach', { comparison: { mode: 'previous_period', display: 'delta' } }), igCtx);
    expect(deltaOnly.ghost).toBeUndefined();
  });

  it('resolves ig.followers from the profile count', () => {
    const r = resolveWidgetMetric(cfg('ig.followers'), igCtx);
    expect(r.valueRaw).toBe(44000);
    expect(r.value).toBeTruthy();
  });

  it('строит level-серию ig.followers из архива followers_total («как ТГ Подписчики»)', () => {
    const history = {
      enabled: true,
      rows: [
        { day: iso(20).slice(0, 10), followers_total: 43000, follows: 10, unfollows: 5 },
        { day: iso(10).slice(0, 10), followers_total: 43500, follows: 8, unfollows: 2 },
        { day: iso(2).slice(0, 10), followers_total: 44000, follows: 1, unfollows: 1 },
      ],
    } as unknown as IgHistoryData;
    const r = resolveWidgetMetric(cfg('ig.followers'), { ...igCtx, ig: { ...igCtx.ig, history } });
    expect(r.empty).toBeFalsy();
    expect(r.valueRaw).toBe(44000); // герой — живое число профиля
    expect(r.series && r.series.length).toBeGreaterThanOrEqual(2);
    const values = r.series!.map((p) => p.value);
    expect(values[0]).toBe(43000); // уровни (последний в бакете), не суммы потока
    expect(Math.max(...values)).toBeLessThanOrEqual(44000);
  });

  it('ig.followers без архива остаётся числом без серии (прежнее поведение)', () => {
    const r = resolveWidgetMetric(cfg('ig.followers'), igCtx);
    expect(r.series).toBeUndefined();
    expect(r.meta?.periodLabel).toBeUndefined();
  });

  it('resolves ig.netFollowers = follows − unfollows', () => {
    const r = resolveWidgetMetric(cfg('ig.netFollowers'), igCtx);
    expect(r.valueRaw).toBe(40); // 50 − 10
    expect(r.value).toMatch(/^\+/);
  });

  it('shows a genuine net-zero window (follows == unfollows) as «0», not empty', () => {
    const zeroIns = {
      data: [
        { name: 'follows', values: [{ end_time: iso(2), value: 40 }] },
        { name: 'unfollows', values: [{ end_time: iso(2), value: 40 }] },
      ],
    } as unknown as IgInsights;
    const r = resolveWidgetMetric(cfg('ig.netFollowers'), { ...igCtx, ig: { ...igCtx.ig, insights: zeroIns } });
    expect(r.empty).toBeFalsy(); // real data, net 0
    expect(r.valueRaw).toBe(0);
  });

  it('returns empty for ig.netFollowers when there is no movement data (hasCur false)', () => {
    expect(resolveWidgetMetric(cfg('ig.netFollowers'), { ...igCtx, ig: {} }).empty).toBe(true);
  });

  it('draws the netFollowers ghost for a genuine net-zero baseline, not just non-zero (S8 Fix 1)', () => {
    const ins = {
      data: [
        { name: 'follows', values: [{ end_time: iso(2), value: 50 }, { end_time: iso(35), value: 20 }] },
        { name: 'unfollows', values: [{ end_time: iso(2), value: 10 }, { end_time: iso(35), value: 20 }] }, // baseline day nets to 0 (REAL data)
      ],
    } as unknown as IgInsights;
    const c: DataContext = { ...igCtx, ig: { ...igCtx.ig, insights: ins } };
    const r = resolveWidgetMetric(cfg('ig.netFollowers', { comparison: { mode: 'previous_period', display: 'ghost_line' } }), c);
    expect(r.ghost).toBeDefined(); // gated on baseline hasCur, so a real net-zero baseline still shows the line
  });

  it('resolves ig.erv = interactions ÷ reach × 100', () => {
    const r = resolveWidgetMetric(cfg('ig.erv'), igCtx);
    expect(r.value).toBe('10.00%'); // 300 / 3000 × 100 — 2 знака, как IG-KPI и страница ig-er
    expect(r.valueRaw).toBeCloseTo(10, 5);
  });

  it('resolves ig.formats with localized labels + format-stable colors, sorted desc', () => {
    const r = resolveWidgetMetric(cfg('ig.formats'), igCtx);
    expect(r.breakdown!.map((i) => i.label)).toEqual(['Reels', 'Лента']);
    expect(r.breakdown!.map((i) => i.value)).toEqual([300, 200]);
    // format-stable hues (MEDIA_PRODUCT_CHART): REEL → chart-2, FEED → chart-1 — matches the dashboard.
    expect(r.breakdown![0].color).toBe('hsl(var(--chart-2))');
    expect(r.breakdown![1].color).toBe('hsl(var(--chart-1))');
  });

  it('resolves ig.age in chronological bucket order (not by value)', () => {
    const r = resolveWidgetMetric(cfg('ig.age'), igCtx);
    expect(r.breakdown!.map((i) => i.label)).toEqual(['18-24', '25-34']); // AGE_ORDER order
    expect(r.breakdown!.map((i) => i.value)).toEqual([500, 800]);
  });

  it('resolves ig.gender with localized labels', () => {
    const r = resolveWidgetMetric(cfg('ig.gender'), igCtx);
    expect(r.breakdown!.map((i) => i.label)).toEqual(['Женщины', 'Мужчины']);
  });

  it('resolves ig.countries / ig.cities (top-N, localized)', () => {
    expect(resolveWidgetMetric(cfg('ig.countries'), igCtx).breakdown![0].value).toBe(900);
    expect(resolveWidgetMetric(cfg('ig.cities'), igCtx).breakdown![0]).toMatchObject({ label: 'Москва', value: 400 });
  });

  it('resolves ig.hours by hour of day (summed grid)', () => {
    const r = resolveWidgetMetric(cfg('ig.hours'), igCtx);
    expect(r.breakdown).toHaveLength(24);
    expect(r.breakdown!.find((i) => i.label === '12:00')!.value).toBe(25);
  });

  it('returns empty for an IG metric with no data (no crash)', () => {
    const bare: DataContext = { ...igCtx, ig: {} };
    expect(resolveWidgetMetric(cfg('ig.reach'), bare).empty).toBe(true);
    expect(resolveWidgetMetric(cfg('ig.followers'), bare).empty).toBe(true);
    expect(resolveWidgetMetric(cfg('ig.formats'), bare).empty).toBe(true);
  });
});

describe('resolveWidgetMetric — unified meta (source + data-quality caption)', () => {
  it('attaches network / period / sample / freshness to a post-derived metric', () => {
    const r = resolveWidgetMetric(cfg('tg.views'), ctx);
    expect(r.meta).toBeDefined();
    expect(r.meta!.network).toBe('tg');
    expect(r.meta!.periodLabel).toBe('за 30 дн.');
    expect(r.meta!.samplePosts).toBe(3); // the 35-day post is out of window
    expect(r.meta!.sourceLabel).toBeUndefined(); // not pinned → follows the switcher, no handle
    // newest data = the 1-day-old post → «вчера», not stale (fixed NOW keeps this deterministic)
    expect(r.meta!.fresh?.label).toBe('вчера');
    expect(r.meta!.fresh?.stale).toBe(false);
  });

  it('names the pinned source (config.source) via the channels payload', () => {
    const r = resolveWidgetMetric(cfg('tg.views', { source: 1 }), ctx);
    expect(r.meta!.sourceLabel).toBe('@bynotem');
  });

  it('reports archive coverage (not post sample) for archive-derived subscribers', () => {
    const r = resolveWidgetMetric(cfg('tg.subscribers'), ctx);
    expect(r.meta!.archiveDays).toBe(2);
    expect(r.meta!.samplePosts).toBeUndefined();
  });

  it('explains a coverage-suppressed comparison instead of silently dropping the ghost', () => {
    const many = Array.from({ length: 100 }, (_, i) => mkPost(1 + (i % 40), 500, 20, 4, 2));
    const cappedCtx: DataContext = {
      ...ctx,
      tg: { ...ctx.tg!, full: { ...(full as object), posts: many } as unknown as TgFull },
    };
    const r = resolveWidgetMetric(cfg('tg.views', { comparison: { mode: 'previous_period', display: 'ghost_line' } }), cappedCtx);
    expect(r.ghost).toBeUndefined();
    expect(r.meta!.comparisonNote).toBe('сравнение скрыто — недостаточно истории постов');
  });

  it('keeps the note absent when the comparison IS drawn', () => {
    const r = resolveWidgetMetric(cfg('tg.views', { comparison: { mode: 'previous_period', display: 'ghost_line' } }), ctx);
    expect(r.ghost).toBeDefined();
    expect(r.meta!.comparisonNote).toBeUndefined();
  });

  it('attaches meta to EMPTY results too (the card must say what was empty)', () => {
    const bare: DataContext = { now: NOW, days: 7, range: null, inRange };
    const r = resolveWidgetMetric(cfg('tg.views'), bare);
    expect(r.empty).toBe(true);
    expect(r.meta).toBeDefined();
    expect(r.meta!.network).toBe('tg');
    expect(r.meta!.periodLabel).toBe('за 7 дн.');
    expect(r.meta!.fresh).toBeUndefined(); // no payloads → no invented freshness
  });

  it('counts the ratio sample (erv) from valid per-post values', () => {
    const r = resolveWidgetMetric(cfg('tg.erv'), ctx);
    expect(r.meta!.samplePosts).toBe(3);
  });

  it('pluralRu picks Russian forms', () => {
    expect(pluralRu(1, ['пост', 'поста', 'постов'])).toBe('пост');
    expect(pluralRu(3, ['пост', 'поста', 'постов'])).toBe('поста');
    expect(pluralRu(12, ['пост', 'поста', 'постов'])).toBe('постов');
    expect(pluralRu(21, ['пост', 'поста', 'постов'])).toBe('пост');
    expect(pluralRu(114, ['пост', 'поста', 'постов'])).toBe('постов');
  });
});

describe('resolveWidgetMetric — meta honesty fixes (verify round)', () => {
  it('does not claim a window on period-agnostic breakdowns (keeps it on post-derived ones)', () => {
    const agnostic = resolveWidgetMetric(cfg('tg.viewsBySource'), ctx);
    expect(agnostic.meta!.periodLabel).toBeUndefined();
    const postDerived = resolveWidgetMetric(cfg('tg.formatPerf'), ctx);
    expect(postDerived.meta!.periodLabel).toBe('за 30 дн.');
  });

  it('explains a comparison with no derivable baseline («Всё» has no shiftable window)', () => {
    const allCtx: DataContext = { ...ctx, days: 0, inRange: () => true };
    const r = resolveWidgetMetric(cfg('tg.views', { comparison: { mode: 'previous_period', display: 'ghost_line' } }), allCtx);
    expect(r.ghost).toBeUndefined();
    expect(r.meta!.comparisonNote).toBe('сравнение недоступно для этого периода');
  });

  it('flags the not-yet-supported netGrowth comparison instead of a dead control', () => {
    const netGraphs = {
      followers: {
        x: [NOW - 2 * DAY, NOW - 1 * DAY],
        series: [
          { name: 'joined', values: [30, 40] },
          { name: 'left', values: [10, 5] },
        ],
      },
    } as unknown as TgGraphs;
    const netCtx: DataContext = { ...ctx, tg: { ...ctx.tg!, graphs: netGraphs } };
    const r = resolveWidgetMetric(cfg('tg.netGrowth', { comparison: { mode: 'previous_period', display: 'ghost_line' } }), netCtx);
    expect(r.empty).toBeFalsy();
    expect(r.meta!.comparisonNote).toBe('сравнение пока не поддерживается для этой метрики');
  });
});

describe('resolveWidgetMetric — визуальный кап длинных серий (generic-слой)', () => {
  // 400-дневное окно: 380 постов по одному в день + 20 пустых дней = 400 дневных бакетов.
  const WIN_FROM_400 = NOW - 399 * DAY;
  const inRange400 = (d: string | null | undefined) => {
    if (!d) return false;
    const t = Date.parse(d);
    return Number.isFinite(t) && t >= WIN_FROM_400 && t <= WIN_TO;
  };
  const manyPosts = Array.from({ length: 380 }, (_, i) => mkPost(i + 1, 100 + (i % 7) * 10));
  const fullLong = { ...(full as object), posts: manyPosts } as unknown as TgFull;
  // days: 0 = пресет «Всё»: окно data-driven — 380 дневных бакетов (только дни с постами).
  const longCtx: DataContext = {
    now: NOW,
    days: 0,
    range: null,
    inRange: inRange400,
    tg: { full: fullLong, history, channels, graphs, channelId: 1 },
  };
  const fullSum = manyPosts.reduce((s, p) => s + p.views, 0);

  it('линия длиннее CHART_MAX_POINTS капается; хедлайн и stats — от ПОЛНОЙ серии', () => {
    const r = resolveWidgetMetric(cfg('tg.views'), longCtx);
    expect(r.empty).toBeFalsy();
    expect(r.series!.length).toBeLessThanOrEqual(140); // CHART_MAX_POINTS (msSeries.ts)
    expect(r.series!.length).toBeGreaterThan(2);
    expect(r.valueRaw).toBe(fullSum); // хедлайн посчитан ДО капа
    expect(r.stats).toBeDefined(); // «Макс/Среднее» от полной 380-точечной серии, не от выборки
    expect(r.stats!.max).toBe(160); // максимум дневного бакета = максимум поста (1 пост/день)
    expect(r.stats!.avg).toBeCloseTo(fullSum / 380, 6);
  });

  it('generic-ghost (moving_average) строится от полной серии и прореживается теми же индексами', () => {
    const r = resolveWidgetMetric(
      cfg('tg.views', { comparison: { mode: 'moving_average', display: 'ghost_line' } }),
      longCtx,
    );
    expect(r.ghost).toBeDefined();
    expect(r.ghost!.length).toBe(r.series!.length); // единые индексы: base↔current не рассинхронены
    expect(r.ghostLabel).toBeTruthy();
  });

  it('бары длиннее CHART_MAX_POINTS агрегируются в календарные недели (децимация дней в столбцах врёт)', () => {
    const r = resolveWidgetMetric(cfg('tg.views', { viz: 'bar' }), longCtx);
    const weekly = r.series ?? [];
    expect(weekly.length).toBeGreaterThan(2);
    expect(weekly.length).toBeLessThanOrEqual(140); // CHART_MAX_POINTS
    // Monday-anchored корзины: date каждой = понедельник, flow-сумма недель = сумма дней.
    expect(weekly.every((p) => new Date(`${p.date}T00:00:00Z`).getUTCDay() === 1)).toBe(true);
    expect(weekly.reduce((sum, p) => sum + p.value, 0)).toBe(fullSum);
    expect(r.valueRaw).toBe(fullSum); // хедлайн по-прежнему от полной дневной серии
    expect(r.meta?.periodLabel).toBe('за всё время · по неделям'); // честный маркер агрегации
  });
});

// ── Яндекс.Метрика (слайс 3): series-семейство из сервер-нарезанного /api/ym/summary ──────────
describe('resolveWidgetMetric — YM series', () => {
  const ymCtx: DataContext = {
    now: NOW,
    days: 30,
    range: null,
    inRange,
    ym: {
      summary: {
        visits: { total: 145, series: [{ day: '2026-06-13', value: 40 }, { day: '2026-06-14', value: 105 }] },
        users: { total: 98, series: [{ day: '2026-06-13', value: 30 }, { day: '2026-06-14', value: 68 }] },
        pageviews: { total: 402, series: [{ day: '2026-06-13', value: 120 }, { day: '2026-06-14', value: 282 }] },
      },
    },
  };

  it('resolves ym.visits/users/pageviews: серия как пришла с сервера, хедлайн = total блока', () => {
    for (const [id, total] of [['ym.visits', 145], ['ym.users', 98], ['ym.pageviews', 402]] as const) {
      const r = resolveWidgetMetric(cfg(id), ymCtx);
      expect(r.empty, id).toBeFalsy();
      expect(r.kind, id).toBe('series');
      expect(r.valueRaw, id).toBe(total);
      expect(r.series!.map((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date)).every(Boolean), id).toBe(true);
      expect(r.meta?.network, id).toBe('ym');
    }
  });

  it('пиновая карточка получает честную сетевую подпись источника («Метрика»)', () => {
    const r = resolveWidgetMetric(cfg('ym.visits', { source: 9 }), ymCtx);
    expect(r.meta?.sourceLabel).toBe('Метрика');
  });

  it('без summary (запрос ещё не пришёл / канал не выбран) — честная пустота, не краш', () => {
    const r = resolveWidgetMetric(cfg('ym.visits'), { now: NOW, days: 30, range: null, inRange, ym: {} });
    expect(r.empty).toBe(true);
  });
});
