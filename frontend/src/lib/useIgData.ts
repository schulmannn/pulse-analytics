// Single source of derived Instagram state. Each of the four IG views calls this; the underlying
// React Query hooks dedupe, so the data is fetched once and the math runs in one place. Keeps the
// view components presentational — they read slices of this bundle, they don't compute metrics.
import { useCallback, useMemo } from 'react';
import {
  useIgProfile,
  useIgInsights,
  useIgPosts,
  useIgBreakdowns,
  useIgOnline,
  useIgStories,
  useIgHistory,
} from '@/api/queries';
import type { IgHistoryRow } from '@/api/schemas';
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
  type Point,
} from '@/lib/igMetrics';

/** Persisted ig_daily rows → {day,value}[] for one column, dropping null/blank days. */
function histSeries(rows: IgHistoryRow[] | undefined, col: keyof IgHistoryRow): Point[] {
  return (rows ?? [])
    .filter((r) => r.day && r[col] != null)
    .map((r) => ({ day: r.day, value: Number(r[col]) }));
}

/** Prefer whichever series carries MORE real dated points. The persisted history (accumulated by
 *  the cron) usually outruns the tiny live API window, but on day 1 the DB is empty — then the live
 *  series wins and the chart is never blank. Ties keep live (fresher within the shared window). */
function longerSeries(live: Point[], persisted: Point[]): Point[] {
  const datedCount = (s: Point[]) =>
    s.filter((p) => p.day !== 'total' && Number.isFinite(Date.parse(p.day))).length;
  return datedCount(persisted) > datedCount(live) ? persisted : live;
}
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
  // DB-first history: the cron accumulates a long ig_daily series past the live API window. Used
  // below only to LENGTHEN the reach/follows daily lines when it has more points (else live wins).
  const historyQ = useIgHistory();

  // Selected window (custom range overrides the days preset; IG insights cap at ~90 days).
  // Quantized to the minute: a raw Date.now() in render produced a new value every render,
  // which would defeat the memos below (and subtly shift the window between sibling views).
  const now = Math.floor(Date.now() / 60_000) * 60_000;
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
  const inWindow = useCallback(
    (iso: string) => {
      const t = Date.parse(iso);
      return Number.isFinite(t) && t >= since && t <= until;
    },
    [since, until],
  );

  const ins = insightsQ.data;
  const histRows = historyQ.data?.rows;
  // The 12× daily-series extraction re-ran on every render of every IG view; the payload ref
  // only changes on refetch, so key the memo on it. reach + follower prefer the PERSISTED series
  // (ig_daily) whenever it's longer than the live window — that's the whole point of the DB-first
  // read path (IG retention pain). Empty DB (day 1) → live series → chart never goes blank.
  const series = useMemo(
    () => ({
      reach: longerSeries(metricSeries(ins, 'reach'), histSeries(histRows, 'reach')),
      // Deduplicated windowed reach (prev+cur synthetic points from the backend total_value call).
      // Used ONLY for the headline KPI / ER denominator — the daily `reach` above still feeds charts.
      reachWindow: metricSeries(ins, 'reach_window'),
      views: metricSeries(ins, 'views'),
      ti: metricSeries(ins, 'total_interactions'),
      engaged: metricSeries(ins, 'accounts_engaged'),
      // Оба конца — НЕТТО-прирост: живой follower_count и колонка ig_daily.followers (крон пишет
      // туда именно follower_count). НЕ мешать с follows (gross новые подписки) — иначе смысл
      // линии молча менялся бы на day-1 кроссовере live↔persisted.
      follower: longerSeries(metricSeries(ins, 'follower_count'), histSeries(histRows, 'followers')),
      saves: metricSeries(ins, 'saves'),
      likes: metricSeries(ins, 'likes'),
      comments: metricSeries(ins, 'comments'),
      shares: metricSeries(ins, 'shares'),
      profileViews: metricSeries(ins, 'profile_views'),
      follows: metricSeries(ins, 'follows'), // gross new follows (FOLLOWER)
      unfollows: metricSeries(ins, 'unfollows'), // gross unfollows (NON_FOLLOWER)
    }),
    [ins, histRows],
  );
  const pairs = useMemo(() => {
    // Prefer Instagram's deduplicated windowed reach ("Accounts reached"); the daily series sums
    // per-day unique reach, double-counting repeat viewers (2–4× inflation vs the app). Fall back to
    // the daily sum only when the windowed aggregate is absent (older payloads / mock without it).
    const reachWin = windowPair(series.reachWindow, since, until);
    const reachDaily = windowPair(series.reach, since, until);
    return {
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
  }, [series, since, until]);

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

  // What drove an engagement rise — the component metric (сохранения / лайки / комментарии / репосты)
  // with the largest positive delta over the window, as a %-lift. Both ends come from the backend's
  // total_value synthetic points (or the mock daily series); hasCur && hasPrev guards a metric with no
  // windowed pair. Attribution reuses data already in the bundle — no new API/DB field.
  const engagementDriver = useMemo(() => {
    const parts = [
      { pair: pairs.saves, label: 'сохранения' },
      { pair: pairs.likes, label: 'лайки' },
      { pair: pairs.comments, label: 'комментарии' },
      { pair: pairs.shares, label: 'репосты' },
    ];
    let best: { label: string; liftPct: number; delta: number } | null = null;
    for (const { pair, label } of parts) {
      if (!pair.hasCur || !pair.hasPrev) continue;
      const delta = pair.cur - pair.prev;
      if (delta <= 0) continue;
      const liftPct = pair.prev > 0 ? (delta / pair.prev) * 100 : 100;
      if (!best || delta > best.delta) best = { label, liftPct, delta };
    }
    return best ? { label: best.label, liftPct: best.liftPct } : null;
  }, [pairs]);

  const posts = useMemo(() => postsQ.data?.data ?? [], [postsQ.data]);
  // Content counts (Reels, top posts, hashtags, compare) and the post-derived insights must
  // reflect the SELECTED period — not the last ~24 fetched posts. Window by publish timestamp so
  // a 7-day view with no Reels shows 0 instead of leaking older Reels (the "2 phantom Reels" bug).
  // Posts without a timestamp are excluded from the window. Depth caveat: only ~24 posts are
  // fetched, so a very wide window on a high-volume channel can still under-count — раскрывается
  // отдельной правкой (limit/`from,to` в /api/ig/posts).
  const postsInWindow = useMemo(
    () => posts.filter((p) => p.timestamp != null && inWindow(p.timestamp)),
    [posts, inWindow],
  );
  const breakdowns = breakdownsQ.data;
  const onlineData = onlineQ.data;
  // Posts/breakdowns/online aggregation, keyed on the payload refs (sorts + hashtag stats).
  const { formatItems, formatTotal, topFormat, onlineAgg, topTag, topPost } = useMemo(() => {
    const formatItems = tvBreakdown(breakdowns?.data, 'total_interactions', 'media_product_type');
    const formatTotal = formatItems.reduce((acc, it) => acc + it.value, 0);
    const topFormat = [...formatItems].sort((a, b) => b.value - a.value)[0];
    const onlineAgg = aggregateOnline(onlineData);
    const topTag = [...hashtagStats(postsInWindow)].filter((t) => t.count >= 2).sort((a, b) => b.lift - a.lift)[0];
    const topPost = postsInWindow.length
      ? [...postsInWindow].sort((a, b) => Number(b.reach ?? 0) - Number(a.reach ?? 0))[0]
      : null;
    return { formatItems, formatTotal, topFormat, onlineAgg, topTag, topPost };
  }, [breakdowns, onlineData, postsInWindow]);

  const insights = buildIgInsights({
    netFollowers: netMovement.hasCur ? netMovement.cur : null,
    follows: pairs.follows.hasCur ? pairs.follows.cur : null,
    unfollows: pairs.unfollows.hasCur ? pairs.unfollows.cur : null,
    erReach,
    erReachPrev,
    engagementDriver,
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
    postCount: postsInWindow.length,
  });

  const isMock = !!(profileQ.data?.mock || insightsQ.data?.mock || postsQ.data?.mock || breakdownsQ.data?.mock);
  // isPending (не isLoading): пока канал не известен, IG-запросы выключены — это тоже «загрузка».
  const loading = profileQ.isPending || insightsQ.isPending || postsQ.isPending;
  const error = profileQ.isError && insightsQ.isError;
  // Real last-sync time the server stamped when it fetched from Instagram (falls back to the React
  // Query receive time only if the server didn't provide one, e.g. demo mode).
  const lastSync =
    profileQ.data?.synced_at ||
    Math.max(profileQ.dataUpdatedAt || 0, insightsQ.dataUpdatedAt || 0, postsQ.dataUpdatedAt || 0);

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
    postsInWindow,
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
