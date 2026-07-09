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
import { usePagePeriod, usePeriod } from '@/lib/period';
import {
  tvBreakdown,
  aggregateOnline,
  hashtagStats,
  hasDailySeries,
  MEDIA_PRODUCT_LABEL,
  DAY_NAMES,
  DAY_MS,
} from '@/lib/igMetrics';
import { igWindowMetrics } from '@/lib/igWindowMetrics';
import { buildIgInsights } from '@/lib/igInsights';

export function useIgData() {
  // Period source, page-first: inside a feed (IgShellRoute provides PagePeriodProvider) the
  // header chips + «Свой период» drive every window here — the same one-control contract as the
  // TG feed. Outside a feed (Home cards, /metrics/ig-* pages) the GLOBAL period still rules, so
  // nothing shifts on those surfaces. When a page period exists, the global range is deliberately
  // NOT read — the page owns its window entirely (no cross-bleed between systems).
  const pagePeriod = usePagePeriod();
  const globalPeriod = usePeriod();
  const days = pagePeriod?.days ?? globalPeriod.days;
  const range = pagePeriod ? pagePeriod.range : globalPeriod.range;
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
  const windowMetrics = useMemo(
    () => igWindowMetrics({ profile: profileQ.data, insights: ins, historyRows: histRows, since, until }),
    [profileQ.data, ins, histRows, since, until],
  );
  const {
    series,
    pairs,
    followerNet: netMovement,
    followersLevel: followers,
    erReach,
    erReachPrev,
  } = windowMetrics;

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
    // Есть ли РЕАЛЬНЫЙ дневной ряд для views/взаимодействий — гейт промоушена их метрик-страниц в
    // дневной график. Считаем по итоговой series.* (архив ИЛИ живой дневной ряд), min=3 отсекает
    // 2-точечный синтет-агрегат живого API — рисуем график только когда он осмысленный.
    viewsHasDaily: hasDailySeries(series.views, 3),
    tiHasDaily: hasDailySeries(series.ti, 3),
    likesHasDaily: hasDailySeries(series.likes, 3),
    savesHasDaily: hasDailySeries(series.saves, 3),
    netMovement,
    queries: { profile: profileQ, insights: insightsQ, posts: postsQ, breakdowns: breakdownsQ, online: onlineQ, stories: storiesQ },
  };
}

export type IgData = ReturnType<typeof useIgData>;
