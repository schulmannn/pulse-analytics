import { describe, expect, it } from 'vitest';
import { resolveWidgetMetric, type DataContext } from '@/lib/resolveWidgetMetric';
import type { WidgetConfig } from '@/lib/widgetConfig';
import type { ChannelsResponse, HistoryData, TgFull } from '@/api/schemas';

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

const mkPost = (daysAgo: number, views: number, reactions = 0, forwards = 0, replies = 0) => ({
  id: Math.round(daysAgo),
  date: iso(daysAgo),
  views,
  reactions,
  forwards,
  replies,
  media_type: 'photo',
});

const full = {
  channel: { memberCount: 44000, username: 'bynotem' },
  posts: [
    mkPost(1, 1000, 50, 10, 5),
    mkPost(5, 2000, 100, 20, 8),
    mkPost(10, 500, 25, 5, 2),
    mkPost(35, 800, 40, 8, 3), // OUTSIDE the active window — only feeds the baseline (ghost)
  ],
} as unknown as TgFull;

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
  tg: { full, history, channels, channelId: 1 },
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

  it('resolves tg.subscribers from the daily archive (level series, last-of-bucket)', () => {
    const r = resolveWidgetMetric(cfg('tg.subscribers'), ctx);
    expect(r.empty).toBeFalsy();
    expect(r.unit).toBe('number');
    expect(r.valueRaw).toBe(44000); // displayMembers from the channels list
    expect(r.series!.map((p) => p.value)).toEqual([43900, 44000]);
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

describe('resolveWidgetMetric — stubs + guards (never throws)', () => {
  it('returns empty for an unknown metric', () => {
    expect(resolveWidgetMetric(cfg('nope.metric'), ctx).empty).toBe(true);
  });

  it('returns empty for IG metrics (S11 not wired yet)', () => {
    expect(resolveWidgetMetric(cfg('ig.reach'), ctx).empty).toBe(true);
  });

  it('returns empty for TG breakdowns (S3b not wired yet)', () => {
    expect(resolveWidgetMetric(cfg('tg.emoji'), ctx).empty).toBe(true);
  });

  it('returns empty when the TG payload is missing rather than crashing', () => {
    const noData: DataContext = { ...ctx, tg: { channelId: null } };
    expect(resolveWidgetMetric(cfg('tg.views'), noData).empty).toBe(true);
    expect(resolveWidgetMetric(cfg('tg.erv'), noData).empty).toBe(true);
  });
});
