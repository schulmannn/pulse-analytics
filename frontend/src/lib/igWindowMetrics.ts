import type { IgHistoryRow, IgInsights, IgProfile } from '@/api/schemas';
import { pctDelta, type MetricDelta } from '@/lib/delta';
import {
  histSeries,
  longerSeries,
  metricSeries,
  netFollowerDaily,
  pairDelta,
  windowPair,
  type Point,
  type WindowPair,
} from '@/lib/igMetrics';

export interface IgWindowRaw {
  profile: IgProfile | undefined;
  insights: IgInsights | undefined;
  historyRows: IgHistoryRow[] | undefined;
  since: number;
  until: number;
}

export interface IgWindowSeries {
  reach: Point[];
  reachWindow: Point[];
  views: Point[];
  ti: Point[];
  engaged: Point[];
  follower: Point[];
  saves: Point[];
  likes: Point[];
  comments: Point[];
  shares: Point[];
  profileViews: Point[];
  follows: Point[];
  unfollows: Point[];
}

export interface IgWindowPairs {
  reach: WindowPair;
  views: WindowPair;
  ti: WindowPair;
  engaged: WindowPair;
  follower: WindowPair;
  saves: WindowPair;
  likes: WindowPair;
  comments: WindowPair;
  shares: WindowPair;
  profileViews: WindowPair;
  follows: WindowPair;
  unfollows: WindowPair;
}

export interface IgWindowScalar {
  value: number;
  previous: number | null;
  delta: MetricDelta | null;
  hasValue: boolean;
  hasPrevious: boolean;
}

export interface IgWindowDaily {
  reach: Point[];
  followerNet: Point[];
  views: Point[];
  totalInteractions: Point[];
  likes: Point[];
  saves: Point[];
}

export interface IgWindowMetrics {
  series: IgWindowSeries;
  pairs: IgWindowPairs;
  daily: IgWindowDaily;
  values: {
    reach: IgWindowScalar;
    views: IgWindowScalar;
    totalInteractions: IgWindowScalar;
    likes: IgWindowScalar;
    saves: IgWindowScalar;
    comments: IgWindowScalar;
    shares: IgWindowScalar;
    followerNet: IgWindowScalar;
    followersLevel: IgWindowScalar;
    erReach: IgWindowScalar;
  };
  followerNet: WindowPair;
  followersLevel: number;
  erReach: number;
  erReachPrev: number;
}

const dated = (series: Point[]): Point[] =>
  series.filter((p) => p.day !== 'total' && Number.isFinite(Date.parse(p.day)));

const scalarFromPair = (pair: WindowPair): IgWindowScalar => ({
  value: pair.cur,
  previous: pair.hasPrev ? pair.prev : null,
  delta: pairDelta(pair),
  hasValue: pair.hasCur,
  hasPrevious: pair.hasPrev,
});

export function igWindowMetrics(raw: IgWindowRaw): IgWindowMetrics {
  const { profile, insights, historyRows, since, until } = raw;
  const series: IgWindowSeries = {
    reach: longerSeries(metricSeries(insights, 'reach'), histSeries(historyRows, 'reach')),
    // Deduplicated windowed reach (prev+cur synthetic points from the backend total_value call).
    // Used for headline reach / ER denominator, with daily reach below kept for charts/narrative.
    reachWindow: metricSeries(insights, 'reach_window'),
    // Additive metrics: prefer the longer DB archive over the live synthetic aggregate when present.
    views: longerSeries(metricSeries(insights, 'views'), histSeries(historyRows, 'views')),
    ti: longerSeries(metricSeries(insights, 'total_interactions'), histSeries(historyRows, 'total_interactions')),
    engaged: metricSeries(insights, 'accounts_engaged'),
    // Level series, not gross follows. Kept for existing daily follower charts.
    follower: longerSeries(metricSeries(insights, 'follower_count'), histSeries(historyRows, 'followers')),
    saves: longerSeries(metricSeries(insights, 'saves'), histSeries(historyRows, 'saves')),
    likes: longerSeries(metricSeries(insights, 'likes'), histSeries(historyRows, 'likes')),
    comments: longerSeries(metricSeries(insights, 'comments'), histSeries(historyRows, 'comments')),
    shares: longerSeries(metricSeries(insights, 'shares'), histSeries(historyRows, 'shares')),
    profileViews: metricSeries(insights, 'profile_views'),
    // Gross movement endpoints. Window net = follows - unfollows.
    follows: metricSeries(insights, 'follows'),
    unfollows: metricSeries(insights, 'unfollows'),
  };

  const reachWin = windowPair(series.reachWindow, since, until);
  const reachDaily = windowPair(series.reach, since, until);
  const pairs: IgWindowPairs = {
    reach: reachWin.hasCur ? reachWin : reachDaily,
    views: windowPair(series.views, since, until),
    ti: windowPair(series.ti, since, until),
    engaged: windowPair(series.engaged, since, until),
    follower: windowPair(series.follower, since, until),
    saves: windowPair(series.saves, since, until),
    likes: windowPair(series.likes, since, until),
    comments: windowPair(series.comments, since, until),
    shares: windowPair(series.shares, since, until),
    profileViews: windowPair(series.profileViews, since, until),
    follows: windowPair(series.follows, since, until),
    unfollows: windowPair(series.unfollows, since, until),
  };

  const followerNet: WindowPair = {
    cur: pairs.follows.cur - pairs.unfollows.cur,
    prev: pairs.follows.prev - pairs.unfollows.prev,
    hasCur: pairs.follows.hasCur || pairs.unfollows.hasCur,
    hasPrev: pairs.follows.hasPrev || pairs.unfollows.hasPrev,
  };
  const followersLevel = profile?.followers_count ?? 0;
  const erReach = pairs.reach.cur > 0 ? (pairs.ti.cur / pairs.reach.cur) * 100 : 0;
  const erReachPrev = pairs.reach.prev > 0 ? (pairs.ti.prev / pairs.reach.prev) * 100 : 0;

  return {
    series,
    pairs,
    daily: {
      reach: dated(series.reach),
      followerNet: dated(netFollowerDaily(historyRows)),
      views: dated(series.views),
      totalInteractions: dated(series.ti),
      likes: dated(series.likes),
      saves: dated(series.saves),
    },
    values: {
      reach: scalarFromPair(pairs.reach),
      views: scalarFromPair(pairs.views),
      totalInteractions: scalarFromPair(pairs.ti),
      likes: scalarFromPair(pairs.likes),
      saves: scalarFromPair(pairs.saves),
      comments: scalarFromPair(pairs.comments),
      shares: scalarFromPair(pairs.shares),
      followerNet: scalarFromPair(followerNet),
      followersLevel: {
        value: followersLevel,
        previous: null,
        delta: null,
        hasValue: profile?.followers_count != null,
        hasPrevious: false,
      },
      erReach: {
        value: erReach,
        previous: erReachPrev > 0 ? erReachPrev : null,
        delta: erReach > 0 && erReachPrev > 0 ? pctDelta(erReach, erReachPrev) : null,
        hasValue: erReach > 0,
        hasPrevious: erReachPrev > 0,
      },
    },
    followerNet,
    followersLevel,
    erReach,
    erReachPrev,
  };
}
