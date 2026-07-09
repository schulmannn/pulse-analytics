import { describe, expect, it } from 'vitest';
import type { IgHistoryRow, IgInsights, IgProfile } from '@/api/schemas';
import { windowIgSeries } from '@/lib/igMetrics';
import { igWindowMetrics } from '@/lib/igWindowMetrics';

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
});
