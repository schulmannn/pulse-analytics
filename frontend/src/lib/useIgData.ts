// Single source of derived Instagram state. Each of the four IG views calls this; the underlying
// React Query hooks dedupe, so the data is fetched once and the math runs in one place. Keeps the
// view components presentational — they read slices of this bundle, they don't compute metrics.
import {
  useIgProfile,
  useIgInsights,
  useIgPosts,
  useIgBreakdowns,
  useIgOnline,
  useIgStories,
} from '@/api/queries';
import { usePeriod } from '@/lib/period';
import {
  metricSeries,
  windowPair,
  tvBreakdown,
  aggregateOnline,
  hashtagStats,
  hasDailySeries,
  MEDIA_PRODUCT_LABEL,
  DAY_NAMES,
  DAY_MS,
} from '@/lib/igMetrics';
import { buildIgInsights } from '@/lib/igInsights';

export function useIgData() {
  const { days, range } = usePeriod();
  const timeframe = days === 7 ? 'last_14_days' : days === 90 || days === 0 ? 'last_90_days' : 'last_30_days';
  const insDays = range
    ? Math.min(90, Math.max(1, Math.ceil((range.to - range.from) / DAY_MS)))
    : days && days > 0 ? Math.min(days, 90) : 90;

  const profileQ = useIgProfile();
  const insightsQ = useIgInsights(insDays);
  const postsQ = useIgPosts(24);
  const breakdownsQ = useIgBreakdowns(timeframe);
  const onlineQ = useIgOnline();
  const storiesQ = useIgStories();

  // Selected window (custom range overrides the days preset; IG insights cap at ~90 days).
  const now = Date.now();
  let windowDays: number;
  let since: number;
  let until = now;
  if (range) {
    since = range.from;
    until = range.to;
    windowDays = Math.min(90, Math.max(1, Math.ceil((range.to - range.from) / DAY_MS)));
  } else {
    windowDays = days && days > 0 ? Math.min(days, 90) : 90;
    since = now - windowDays * DAY_MS;
  }
  const inWindow = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= since && t <= until;
  };

  const ins = insightsQ.data;
  const series = {
    reach: metricSeries(ins, 'reach'),
    views: metricSeries(ins, 'views'),
    ti: metricSeries(ins, 'total_interactions'),
    engaged: metricSeries(ins, 'accounts_engaged'),
    follower: metricSeries(ins, 'follower_count'),
    saves: metricSeries(ins, 'saves'),
    likes: metricSeries(ins, 'likes'),
    comments: metricSeries(ins, 'comments'),
    shares: metricSeries(ins, 'shares'),
    profileViews: metricSeries(ins, 'profile_views'),
    follows: metricSeries(ins, 'follows'), // gross new follows (FOLLOWER)
    unfollows: metricSeries(ins, 'unfollows'), // gross unfollows (NON_FOLLOWER)
  };
  const pairs = {
    reach: windowPair(series.reach, since, until),
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

  // Real subscriber movement for the window: net = gross follows − gross unfollows. This is the
  // honest growth number — the dashboard previously reported gross follows alone as "growth".
  const netMovement = {
    cur: pairs.follows.cur - pairs.unfollows.cur,
    prev: pairs.follows.prev - pairs.unfollows.prev,
    hasCur: pairs.follows.hasCur || pairs.unfollows.hasCur,
    hasPrev: pairs.follows.hasPrev || pairs.unfollows.hasPrev,
  };

  const followers = profileQ.data?.followers_count ?? 0;
  const erReach = pairs.reach.cur > 0 ? (pairs.ti.cur / pairs.reach.cur) * 100 : 0;
  const erReachPrev = pairs.reach.prev > 0 ? (pairs.ti.prev / pairs.reach.prev) * 100 : 0;

  const posts = postsQ.data?.data ?? [];
  const breakdowns = breakdownsQ.data;
  const formatItems = tvBreakdown(breakdowns?.data, 'total_interactions', 'media_product_type');
  const formatTotal = formatItems.reduce((acc, it) => acc + it.value, 0);
  const topFormat = [...formatItems].sort((a, b) => b.value - a.value)[0];
  const onlineAgg = aggregateOnline(onlineQ.data);
  const topTag = [...hashtagStats(posts)].filter((t) => t.count >= 2).sort((a, b) => b.lift - a.lift)[0];
  const topPost = posts.length
    ? [...posts].sort((a, b) => Number(b.reach ?? 0) - Number(a.reach ?? 0))[0]
    : null;

  const insights = buildIgInsights({
    netFollowers: netMovement.hasCur ? netMovement.cur : null,
    follows: pairs.follows.hasCur ? pairs.follows.cur : null,
    unfollows: pairs.unfollows.hasCur ? pairs.unfollows.cur : null,
    erReach,
    erReachPrev,
    bestFormat:
      topFormat && formatTotal > 0
        ? {
            label: MEDIA_PRODUCT_LABEL[topFormat.label] ?? topFormat.label,
            sharePct: (topFormat.value / formatTotal) * 100,
            interactions: topFormat.value,
            total: formatTotal,
          }
        : null,
    // Only when online_followers actually returned activity — otherwise no "best time" claim.
    bestSlot: onlineAgg.hasSignal
      ? { day: DAY_NAMES[onlineAgg.best.w], hour: onlineAgg.best.h, online: onlineAgg.best.v }
      : null,
    topHashtag: topTag ? { tag: topTag.tag, lift: topTag.lift, count: topTag.count } : null,
    topPost: topPost ? { reach: Number(topPost.reach ?? 0), type: topPost.media_type } : null,
    postCount: posts.length,
  });

  const isMock = !!(profileQ.data?.mock || insightsQ.data?.mock || postsQ.data?.mock || breakdownsQ.data?.mock);
  const loading = profileQ.isLoading || insightsQ.isLoading || postsQ.isLoading;
  const error = profileQ.isError && insightsQ.isError;
  const lastSync = Math.max(
    profileQ.dataUpdatedAt || 0,
    insightsQ.dataUpdatedAt || 0,
    postsQ.dataUpdatedAt || 0,
    breakdownsQ.dataUpdatedAt || 0,
  );

  return {
    loading,
    error,
    isMock,
    lastSync,
    profile: profileQ.data,
    window: { since, until, days: windowDays },
    inWindow,
    series,
    pairs,
    followers,
    erReach,
    erReachPrev,
    posts,
    breakdowns,
    online: onlineQ.data,
    onlineAgg,
    stories: storiesQ.data?.data ?? [],
    formatItems,
    formatTotal,
    topFormat,
    topPost,
    insights,
    reachHasDaily: hasDailySeries(series.reach),
    followerHasDaily: hasDailySeries(series.follower),
    netMovement,
    queries: { profile: profileQ, insights: insightsQ, posts: postsQ, breakdowns: breakdownsQ, online: onlineQ, stories: storiesQ },
  };
}

export type IgData = ReturnType<typeof useIgData>;
