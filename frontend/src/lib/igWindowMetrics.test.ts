import { describe, expect, it } from 'vitest';
import type { IgHistoryRow, IgInsights, IgProfile } from '@/api/schemas';
import { fmtDay, windowIgSeries, type Point } from '@/lib/igMetrics';
import { igOverviewCharts, igWindowMetrics, type IgWindowSeries } from '@/lib/igWindowMetrics';

const DAY_MS = 24 * 60 * 60 * 1000;
const baseMs = Date.parse('2026-07-01T00:00:00.000Z');
const day = (i: number) => new Date(baseMs + i * DAY_MS).toISOString().slice(0, 10);
const sum = (vals: number[]) => vals.reduce((acc, value) => acc + value, 0);
const prev = <T,>(vals: T[]) => vals.slice(0, 7);
const cur = <T,>(vals: T[]) => vals.slice(7, 14);

const reachVals = [410, 620, 580, 505, 470, 305, 690, 845, 900, 610, 720, 655, 515, 980];
const viewVals = [980, 454, 463, 471, 467, 380, 417, 845, 381, 691, 314, 250, 242, 166];
const tiVals = [58, 41, 34, 36, 39, 22, 51, 67, 42, 61, 40, 18, 24, 33];
const likeVals = [32, 20, 19, 21, 23, 14, 25, 39, 24, 36, 19, 9, 12, 20];
const saveVals = [8, 7, 5, 4, 5, 3, 6, 9, 7, 8, 5, 2, 3, 5];
const commentVals = [4, 3, 2, 3, 2, 1, 4, 5, 3, 4, 2, 1, 2, 3];
const shareVals = [14, 11, 8, 8, 9, 4, 16, 14, 8, 13, 14, 6, 7, 5];
const followVals = [8, 11, 7, 10, 6, 5, 12, 9, 6, 7, 10, 4, 8, 13];
const unfollowVals = [4, 5, 5, 6, 5, 4, 7, 11, 9, 5, 8, 7, 6, 10];
const followerLevels = [12440, 12446, 12448, 12452, 12453, 12454, 12459, 12457, 12454, 12456, 12458, 12455, 12457, 12460];

function metric(name: string, vals: number[]): NonNullable<IgInsights['data']>[number] {
  return {
    name,
    period: 'day',
    values: vals.map((value, i) => ({ value, end_time: day(i) })),
  };
}

function windowMetric(name: string, previous: number, current: number): NonNullable<IgInsights['data']>[number] {
  return {
    name,
    period: 'day',
    values: [
      { value: previous, end_time: day(6) },
      { value: current, end_time: day(13) },
    ],
  };
}

function fixedRaw() {
  const insights: IgInsights = {
    data: [
      metric('reach', reachVals),
      windowMetric('reach_window', sum(prev(reachVals)), sum(cur(reachVals))),
      metric('views', viewVals),
      metric('total_interactions', tiVals),
      metric('likes', likeVals),
      metric('saves', saveVals),
      metric('comments', commentVals),
      metric('shares', shareVals),
      metric('accounts_engaged', tiVals.map((v) => Math.round(v * 1.5))),
      metric('profile_views', viewVals.map((v) => Math.round(v * 0.1))),
      metric('follows', followVals),
      metric('unfollows', unfollowVals),
      metric('follower_count', followerLevels),
    ],
  };
  const historyRows: IgHistoryRow[] = reachVals.map((reach, i) => ({
    day: day(i),
    followers: followerLevels[i],
    reach,
    views: viewVals[i],
    total_interactions: tiVals[i],
    likes: likeVals[i],
    saves: saveVals[i],
    comments: commentVals[i],
    shares: shareVals[i],
    follows: followVals[i],
    unfollows: unfollowVals[i],
  }));
  const profile: IgProfile = { followers_count: 12460 };
  const since = Date.parse(day(7));
  const until = Date.parse(day(14));
  return { profile, insights, historyRows, since, until };
}

describe('igWindowMetrics', () => {
  it('builds canonical IG window scalars, deltas and daily series from raw payloads', () => {
    const metrics = igWindowMetrics(fixedRaw());
    const reachCur = sum(cur(reachVals));
    const viewsCur = sum(cur(viewVals));
    const tiCur = sum(cur(tiVals));
    const netCur = sum(cur(followVals)) - sum(cur(unfollowVals));

    expect(metrics.pairs.reach.cur).toBe(reachCur);
    expect(metrics.values.reach.previous).toBe(sum(prev(reachVals)));
    expect(metrics.values.views.value).toBe(viewsCur);
    expect(metrics.values.totalInteractions.value).toBe(tiCur);
    expect(metrics.followerNet.cur).toBe(netCur);
    expect(metrics.followersLevel).toBe(12460);
    expect(metrics.erReach).toBe((tiCur / reachCur) * 100);
    expect(metrics.values.views.delta?.dir).toBe('down');
    expect(metrics.daily.followerNet.map((p) => p.value)).toEqual(followVals.map((v, i) => v - unfollowVals[i]));
  });

  it('keeps KPI path equal to narrative daily-window path for reach, followerNet, views and total interactions', () => {
    const metrics = igWindowMetrics(fixedRaw());
    const narrativeReach = windowIgSeries(metrics.daily.reach, 7, 'reach').total;
    const narrativeFollowerNet = windowIgSeries(metrics.daily.followerNet, 7, 'followers').total;
    const narrativeViews = windowIgSeries(metrics.daily.views, 7, 'views').total;
    const narrativeTi = windowIgSeries(metrics.daily.totalInteractions, 7, 'interactions').total;

    expect(metrics.values.reach.value).toBe(narrativeReach);
    expect(metrics.values.followerNet.value).toBe(narrativeFollowerNet);
    expect(metrics.values.views.value).toBe(narrativeViews);
    expect(metrics.values.totalInteractions.value).toBe(narrativeTi);
  });

  it('exposes overviewCharts from the canonical daily series over the active window', () => {
    const metrics = igWindowMetrics(fixedRaw());
    // fixedRaw window = day(7)..day(14): the last 7 daily points (indices 7..13).
    expect(metrics.overviewCharts.views.values).toEqual(viewVals.slice(7));
    expect(metrics.overviewCharts.interactions.values).toEqual(tiVals.slice(7));
    expect(metrics.overviewCharts.engagement.values).toEqual(
      tiVals.slice(7).map((ti, i) => (ti / reachVals.slice(7)[i]) * 100),
    );
  });
});

/**
 * The three compact IG Overview sparklines (Просмотры / Взаимодействия / Вовлечённость) build ONLY
 * on the canonical account daily series filtered to the exact active window. Pin: daily ER
 * alignment, sorting/sparse dates, zero/missing reach, exact window filtering and the synthetic-
 * aggregate gate (a 1–2 point total_value aggregate must never pass as a chartable series).
 */
describe('igOverviewCharts', () => {
  const pts = (rows: Array<[string, number]>): Point[] => rows.map(([day, value]) => ({ day, value }));
  const makeSeries = (o: Partial<Record<'views' | 'ti' | 'reach', Point[]>>): IgWindowSeries => {
    const e: Point[] = [];
    return {
      reach: o.reach ?? e, reachWindow: e, views: o.views ?? e, ti: o.ti ?? e, engaged: e,
      follower: e, followerLevel: e, saves: e, likes: e, comments: e, shares: e,
      profileViews: e, follows: e, unfollows: e,
    };
  };
  // Inclusive window [08 .. 14] July 2026 (bounds at UTC midnight, like the daily archive days).
  const SINCE = Date.parse('2026-07-08');
  const UNTIL = Date.parse('2026-07-14');
  const d = (n: number) => `2026-07-${String(n).padStart(2, '0')}`;

  it('daily ER = 100·interactions ÷ reach aligned by calendar day; views/interactions pass through', () => {
    const series = makeSeries({
      views: pts([[d(8), 100], [d(9), 200], [d(10), 300]]),
      ti: pts([[d(8), 10], [d(9), 30], [d(10), 25]]),
      reach: pts([[d(8), 100], [d(9), 200], [d(10), 50]]),
    });
    const c = igOverviewCharts(series, SINCE, UNTIL);
    expect(c.views.values).toEqual([100, 200, 300]);
    expect(c.interactions.values).toEqual([10, 30, 25]);
    // 100·10/100=10, 100·30/200=15, 100·25/50=50
    expect(c.engagement.labels).toEqual([fmtDay(d(8)), fmtDay(d(9)), fmtDay(d(10))]);
    expect(c.engagement.values[0]).toBeCloseTo(10, 10);
    expect(c.engagement.values[1]).toBeCloseTo(15, 10);
    expect(c.engagement.values[2]).toBeCloseTo(50, 10);
  });

  it('sorts oldest→newest and never zero-fills sparse days', () => {
    const series = makeSeries({
      views: pts([[d(12), 300], [d(8), 100], [d(10), 200]]), // out of order, gaps at 09 & 11
      ti: pts([[d(12), 3], [d(8), 1], [d(10), 2]]),
      reach: pts([[d(12), 100], [d(8), 100], [d(10), 100]]),
    });
    const c = igOverviewCharts(series, SINCE, UNTIL);
    expect(c.views.labels).toEqual([fmtDay(d(8)), fmtDay(d(10)), fmtDay(d(12))]);
    expect(c.views.values).toEqual([100, 200, 300]); // exactly three buckets, no filled zeros
    expect(c.engagement.values).toHaveLength(3);
    [1, 2, 3].forEach((expected, i) => {
      expect(c.engagement.values[i]).toBeCloseTo(expected, 10);
    });
  });

  it('engagement skips days without a positive reach or without a real interaction point', () => {
    const series = makeSeries({
      ti: pts([[d(8), 10], [d(9), 20], [d(10), 30], [d(11), 40]]),
      // 09 reach 0 → skip; 11 reach missing → skip; only 08 & 10 survive.
      reach: pts([[d(8), 100], [d(9), 0], [d(10), 50]]),
    });
    const c = igOverviewCharts(series, SINCE, UNTIL);
    expect(c.interactions.values).toEqual([10, 20, 30, 40]); // interactions unaffected by reach
    expect(c.engagement.labels).toEqual([fmtDay(d(8)), fmtDay(d(10))]);
    expect(c.engagement.values[0]).toBeCloseTo(10, 10); // 100·10/100
    expect(c.engagement.values[1]).toBeCloseTo(60, 10); // 100·30/50
  });

  it('filters to the exact active window, dropping points before/after', () => {
    const all = pts([[d(5), 1], [d(6), 2], [d(8), 3], [d(9), 4], [d(14), 5], [d(15), 6]]);
    const series = makeSeries({ views: all, ti: all, reach: all });
    const c = igOverviewCharts(series, SINCE, UNTIL); // keep 08, 09, 14 (14 is the inclusive bound)
    expect(c.views.labels).toEqual([fmtDay(d(8)), fmtDay(d(9)), fmtDay(d(14))]);
    expect(c.views.values).toEqual([3, 4, 5]);
  });

  it('rejects the synthetic total_value aggregate (1 total point or a 2-point prev/cur pair)', () => {
    const single = igOverviewCharts(makeSeries({ views: pts([['total', 5000]]), ti: pts([['total', 800]]) }), SINCE, UNTIL);
    expect(single.views.values).toEqual([]);
    expect(single.interactions.values).toEqual([]);
    // Two real dated points (the shape of the prev/cur aggregate) still fall short of the ≥3
    // canonical minimum → no chart, so the aggregate can't masquerade as a daily series.
    const pair = igOverviewCharts(makeSeries({ views: pts([[d(8), 100], [d(14), 200]]) }), SINCE, UNTIL);
    expect(pair.views.values).toEqual([]);
  });

  it('returns an empty chart when fewer than two canonical points fall inside the window', () => {
    // Canonical series (3 dated points overall), but only one lands in the active window.
    const series = makeSeries({ views: pts([[d(1), 1], [d(2), 2], [d(8), 3]]) });
    expect(igOverviewCharts(series, SINCE, UNTIL).views.values).toEqual([]);
  });
});
