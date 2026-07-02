import type { ChannelsResponse, HistoryData, TgFull } from '@/api/schemas';
import { fmt } from '@/lib/format';
import { normalizeTgPosts } from '@/lib/posts';
import { effectiveLimit } from '@/lib/period';
import type { DateRange, PeriodDays } from '@/lib/period';
import { avgReachWindowDelta, dailyWindowDelta, pctDelta, subscriberChange, subscriberDelta, sumPostWindows } from '@/lib/delta';
import type { MetricDelta } from '@/lib/delta';

/** A daily metric series: aligned day labels + values (sparklines, drills, metric pages). */
export interface DailySeries {
  labels: string[];
  values: number[];
}

/** KPI metrics that have a dedicated metric page (subset of MetricKey shown as a KPI). */
export type DrillKey = 'views' | 'subscribers' | 'avgReach' | 'reactions' | 'forwards' | 'er';
export const DRILL_KEYS: readonly DrillKey[] = ['views', 'subscribers', 'avgReach', 'reactions', 'forwards', 'er'];

export function isDrillKey(raw: string | undefined): raw is DrillKey {
  return DRILL_KEYS.includes(raw as DrillKey);
}

/**
 * Every KPI aggregate/window/series in one pure pass — shared by the Overview KPI grid and the
 * metric pages so a headline and its page always reconcile (same math, same sources).
 *
 * Displayed subscriber count comes from the channels list (server-derived from the latest
 * channel_daily row), falling back to the live /api/tg/full count. The trend pill + sparkline
 * read that archive via /api/history (a separate endpoint / cache), so the shown Δ is
 * directional context, not exact (headline − baseline) arithmetic. The live `members`
 * stays the ER/avg divisor (parity with the legacy formula).
 */
export function deriveKpis(
  data: TgFull | undefined,
  history: HistoryData | undefined,
  channelsData: ChannelsResponse | undefined,
  channelId: number | null,
  days: PeriodDays,
  range: DateRange | null,
  inRange: (dateISO: string | null | undefined) => boolean,
) {
  const members = data?.channel?.memberCount ?? data?.channel?.members ?? 0;
  const current = channelsData?.channels.find((c) => c.id === channelId);
  const displayMembers = current?.memberCount ?? members;
  const posts = (data?.posts ?? []).filter((post) => inRange(post.date));
  const totalViews = posts.reduce((sum, post) => sum + Number(post.views ?? post.view_count ?? 0), 0);
  const totalReactions = posts.reduce(
    (sum, post) => sum + Number(post.reactions ?? post.reactions_count ?? 0),
    0,
  );
  const totalForwards = posts.reduce((sum, post) => sum + Number(post.forwards ?? 0), 0);
  const totalReplies = posts.reduce((sum, post) => sum + Number(post.replies ?? post.comments_count ?? 0), 0);
  const postsAnalyzed = posts.length;
  const avgViews = postsAnalyzed > 0 ? totalViews / postsAnalyzed : 0;
  const er = members > 0 ? ((totalReactions + totalReplies + totalForwards) / members) * 100 : 0;
  const subscriberTrend = subscriberDelta(history?.rows ?? [], days);
  const windowTotals = sumPostWindows(
    (data?.posts ?? []).map((post) => ({
      date: post.date,
      views: Number(post.views ?? post.view_count ?? 0),
      reactions: Number(post.reactions ?? post.reactions_count ?? 0),
      forwards: Number(post.forwards ?? 0),
      replies: Number(post.replies ?? post.comments_count ?? 0),
    })),
    days,
  );
  const currentEngagement = windowTotals
    ? windowTotals.current.reactions + windowTotals.current.forwards + windowTotals.current.replies
    : null;
  const previousEngagement = windowTotals
    ? windowTotals.previous.reactions + windowTotals.previous.forwards + windowTotals.previous.replies
    : null;

  const historyRows = history?.rows ?? [];
  const viewsTrend =
    dailyWindowDelta(historyRows, (r) => Number(r.views ?? 0), days)
    ?? (windowTotals ? pctDelta(windowTotals.current.views, windowTotals.previous.views) : null);
  const reactionsTrend =
    dailyWindowDelta(historyRows, (r) => Number(r.reactions ?? 0), days)
    ?? (windowTotals ? pctDelta(windowTotals.current.reactions, windowTotals.previous.reactions) : null);
  const forwardsTrend =
    dailyWindowDelta(historyRows, (r) => Number(r.forwards ?? 0), days)
    ?? (windowTotals ? pctDelta(windowTotals.current.forwards, windowTotals.previous.forwards) : null);
  const erTrend =
    dailyWindowDelta(historyRows, (r) => Number(r.reactions ?? 0) + Number(r.forwards ?? 0), days)
    ?? (members > 0 && currentEngagement != null && previousEngagement != null
      ? pctDelta(currentEngagement / members, previousEngagement / members)
      : null);
  const avgReachTrend = avgReachWindowDelta(
    (data?.posts ?? []).map((post) => ({
      date: post.date,
      views: Number(post.views ?? post.view_count ?? 0),
    })),
    days,
  );

  // Per-metric daily series for the inline sparklines (within the active window). Carries the
  // day labels alongside the values so the interactive read-out can name the hovered point.
  const dailySeries = (value: (post: (typeof posts)[number]) => number): DailySeries => {
    const byDay = new Map<string, number>();
    posts.forEach((post) => {
      if (!post.date) return;
      const timestamp = Date.parse(post.date);
      if (!Number.isFinite(timestamp)) return;
      const key = new Date(timestamp).toISOString().slice(0, 10);
      byDay.set(key, (byDay.get(key) ?? 0) + value(post));
    });
    const entries = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
    return { labels: entries.map(([k]) => fmt.day(k)), values: entries.map(([, v]) => v) };
  };
  const viewsSpark = dailySeries((post) => Number(post.views ?? post.view_count ?? 0));
  // Subscriber trend from the daily archive (reliable, unlike post-derived views).
  const subsRows = historyRows
    .filter((row) => row.subscribers != null && inRange(row.day))
    .sort((a, b) => a.day.localeCompare(b.day));
  const subsSpark: DailySeries = {
    labels: subsRows.map((row) => fmt.day(row.day)),
    values: subsRows.map((row) => Number(row.subscribers)),
  };
  // Absolute subscriber change ("−108 за 30 дн.") — more legible than the % alone. Only for the
  // `days` presets: a custom date range overrides the preset window, so a preset-based number +
  // label would contradict the (range-filtered) sparkline → fall back to a neutral caption.
  const subChange = range ? null : subscriberChange(historyRows, days);
  const periodLabel = days === 0 ? 'всё время' : `${days} дн.`;
  const subCaption =
    subChange != null && subChange !== 0
      ? `${subChange > 0 ? '+' : '−'}${fmt.num(Math.abs(subChange))} за ${periodLabel}`
      : 'в канале';

  // Absolute "+N к пред. периоду" captions (current vs previous equal-length window). Like the
  // subscriber Δ, only for preset windows — a custom range overrides the preset, so the paired
  // window math wouldn't match the shown range. ER is expressed in percentage points.
  const signedAbs = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt.num(Math.abs(n))}`;
  const vsPrev = (cur: number, prev: number): string | null =>
    range ? null : `${signedAbs(cur - prev)} к пред. периоду`;
  const viewsAbsCaption = windowTotals ? vsPrev(windowTotals.current.views, windowTotals.previous.views) : null;
  const reactionsCaption = windowTotals ? vsPrev(windowTotals.current.reactions, windowTotals.previous.reactions) : null;
  const forwardsCaption = windowTotals ? vsPrev(windowTotals.current.forwards, windowTotals.previous.forwards) : null;
  const erPp =
    !range && members > 0 && currentEngagement != null && previousEngagement != null
      ? ((currentEngagement - previousEngagement) / members) * 100
      : null;
  const erCaption =
    erPp != null && Math.abs(erPp) >= 0.05 ? `${erPp > 0 ? '+' : '−'}${Math.abs(erPp).toFixed(1)} п.п.` : null;
  // «Всё» на деле означает «последние 100 постов» (fetch-лимит) — когда выборка упирается в
  // кап, честно говорим «по последним N постам», а не молча выдаём срез за «всё время».
  const atFetchCap = days === 0 && !range && (data?.posts?.length ?? 0) >= effectiveLimit(days, range);
  const viewsBase = postsAnalyzed
    ? atFetchCap
      ? `по последним ${postsAnalyzed} постам`
      : `по ${postsAnalyzed} постам`
    : null;
  const viewsCaption = [viewsBase, viewsAbsCaption].filter(Boolean).join(' · ') || null;

  // Compact inline ledger deltas (Figma: signed-absolute next to subs/reactions, ER in п.п.; avg-reach
  // keeps the percent pill). Preset windows only — a custom range has no paired previous window.
  const subDelta = subChange != null && subChange !== 0 ? signedAbs(subChange) : null;
  const reactionsDiff = !range && windowTotals ? windowTotals.current.reactions - windowTotals.previous.reactions : null;
  const reactionsDelta = reactionsDiff ? signedAbs(reactionsDiff) : null;

  // Normalized posts in the active window — the per-post attribution source for the metric
  // pages. Uses the same fields the KPI totals sum, so the breakdown reconciles with the headline.
  const normPosts = normalizeTgPosts(data?.posts ?? [], data?.channel ?? {}).filter((post) => inRange(post.date));
  const drillMeta: Record<DrillKey, { total: string; trend?: MetricDelta | null; caption?: string | null }> = {
    views: { total: fmt.short(totalViews), trend: viewsTrend, caption: viewsCaption },
    subscribers: { total: fmt.num(displayMembers), trend: subscriberTrend, caption: subCaption },
    avgReach: { total: fmt.short(avgViews), trend: avgReachTrend, caption: null },
    reactions: { total: fmt.short(totalReactions), trend: reactionsTrend, caption: reactionsCaption },
    forwards: { total: fmt.short(totalForwards), trend: forwardsTrend, caption: forwardsCaption },
    er: { total: er > 0 ? er.toFixed(2) + '%' : '—', trend: erTrend, caption: erCaption },
  };

  return {
    members, displayMembers, totalViews, totalReactions, avgViews, er,
    subscriberTrend, viewsTrend, reactionsTrend, erTrend, avgReachTrend,
    viewsSpark, subsSpark, periodLabel, viewsCaption, subDelta, reactionsDelta, erCaption,
    normPosts, drillMeta,
    // Extras the metric pages need beyond the grid: paired-window totals for the
    // «Сравнение» ledger and the raw archive rows for subscriber window math.
    windowTotals, currentEngagement, previousEngagement, historyRows,
  };
}
