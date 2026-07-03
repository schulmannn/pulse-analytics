import { describe, expect, it } from 'vitest';
import { resolveWidgetMetric, type DataContext } from '@/lib/resolveWidgetMetric';
import type { WidgetConfig } from '@/lib/widgetConfig';
import type {
  ChannelsResponse,
  HistoryData,
  IgBreakdowns,
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
    expect(r.breakdown![0].display).toMatch(/% ERV · \d+ шт$/);
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
    expect(r.value).toBe('10.0%'); // 300 / 3000 × 100
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
