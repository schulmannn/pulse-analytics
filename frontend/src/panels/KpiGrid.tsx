import { useState } from 'react';
import type { ReactNode } from 'react';
import { useChannels, useHistory, useTgFull } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { fmt } from '@/lib/format';
import { cn } from '@/lib/utils';
import { normalizeTgPosts } from '@/lib/posts';
import { Card, CardContent } from '@/components/ui/card';
import { Sparkline } from '@/components/Sparkline';
import { MetricInfo } from '@/components/InfoTooltip';
import { DeltaPill } from '@/components/DeltaPill';
import { KpiDrillDown } from '@/components/KpiDrillDown';
import { Skeleton } from '@/components/ui/skeleton';
import { usePeriod } from '@/lib/period';
import { avgReachWindowDelta, dailyWindowDelta, pctDelta, subscriberChange, subscriberDelta, sumPostWindows } from '@/lib/delta';
import type { MetricDelta } from '@/lib/delta';
import { METRIC_DEFS } from '@/lib/metricDefs';
import type { MetricDef } from '@/lib/metricDefs';

/** KPI cards that support a drill-down (subset of MetricKey that maps to a shown KPI). */
type DrillKey = 'views' | 'subscribers' | 'avgReach' | 'reactions' | 'forwards' | 'er';

/** Sparkline hue: green/red when the metric is trending, brand iris when flat/unknown. */
function sparkColor(trend?: MetricDelta | null): string {
  if (trend?.dir === 'up') return 'hsl(var(--brand-verdant))';
  if (trend?.dir === 'down') return 'hsl(var(--brand-ember))';
  return 'hsl(var(--brand-iris))';
}

/** Split a formatted value ("7.9k" / "8.20%") into [number, unit] so the unit reads quieter. */
function splitUnit(value: string): [string, string] {
  const match = value.match(/^([\d\s.,]+)(.*)$/);
  return match ? [match[1], match[2]] : [value, ''];
}

/**
 * Telegram KPI cards with a clear hierarchy: two featured metrics (large number + gradient
 * sparkline) lead, the rest follow as a compact stat strip with trend-coloured sparklines.
 * Δ vs the previous period comes from the channel_daily archive (reliable), falling back to
 * the post-window sum; sparse data → null → no pill, never a made-up number.
 */
export function KpiGrid() {
  const { days, range, inRange } = usePeriod();
  const { data, isLoading, isError, error } = useTgFull(days);
  const { data: history } = useHistory(730);
  const { channelId } = useSelectedChannel();
  const { data: channelsData } = useChannels();
  const [drill, setDrill] = useState<DrillKey | null>(null);

  if (isLoading) return <KpiSkeletons />;
  if (isError) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Не удалось загрузить метрики: {error instanceof Error ? error.message : 'ошибка'}
        </CardContent>
      </Card>
    );
  }

  const members = data?.channel?.memberCount ?? data?.channel?.members ?? 0;
  // Displayed subscriber count comes from the channels list (server-derived from the latest
  // channel_daily row — the same archive the Hero uses), falling back to the live /api/tg/full
  // count. The trend pill + sparkline read that archive via /api/history (a separate endpoint /
  // cache), so the shown Δ is directional context, not exact (headline − baseline) arithmetic.
  // The live `members` above stays the ER/avg divisor (parity with the legacy formula).
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
  const reactionsSpark = dailySeries((post) => Number(post.reactions ?? post.reactions_count ?? 0));
  const engagementSpark = dailySeries(
    (post) =>
      Number(post.reactions ?? post.reactions_count ?? 0) +
      Number(post.forwards ?? 0) +
      Number(post.replies ?? post.comments_count ?? 0),
  );
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
  const viewsBase = postsAnalyzed ? `по ${postsAnalyzed} постам` : null;
  const viewsCaption = [viewsBase, viewsAbsCaption].filter(Boolean).join(' · ') || null;

  // Normalized posts in the active window — the per-post attribution source for the drill-down.
  // Uses the same fields the KPI totals sum, so the breakdown reconciles with the headline.
  const normPosts = normalizeTgPosts(data?.posts ?? [], data?.channel ?? {}).filter((post) => inRange(post.date));
  const drillMeta: Record<DrillKey, { total: string; trend?: MetricDelta | null; caption?: string | null }> = {
    views: { total: fmt.short(totalViews), trend: viewsTrend, caption: viewsCaption },
    subscribers: { total: fmt.num(displayMembers), trend: subscriberTrend, caption: subCaption },
    avgReach: { total: fmt.short(avgViews), trend: avgReachTrend, caption: null },
    reactions: { total: fmt.short(totalReactions), trend: reactionsTrend, caption: reactionsCaption },
    forwards: { total: fmt.short(totalForwards), trend: forwardsTrend, caption: forwardsCaption },
    er: { total: er > 0 ? er.toFixed(2) + '%' : '—', trend: erTrend, caption: erCaption },
  };

  return (
    <div className="space-y-5">
      {/* HERO — primary metric: big number + area sparkline (Figma Overview lead). */}
      <FeaturedKpi
        label="Просмотры за период"
        value={fmt.short(totalViews)}
        trend={viewsTrend}
        caption={viewsCaption}
        spark={viewsSpark}
        info={METRIC_DEFS.views}
        onDrill={() => setDrill('views')}
      />
      {/* LEDGER — secondary metrics as hairline columns (Figma: Подписчики / Ср.охват / Реакции / ER). */}
      <div className="grid grid-cols-2 gap-px border-t border-border bg-border lg:grid-cols-4">
        <StatTile label="Подписчики" value={fmt.num(displayMembers)} trend={subscriberTrend} spark={subsSpark} caption={subCaption} info={METRIC_DEFS.subscribers} onDrill={() => setDrill('subscribers')} />
        <StatTile label="Ср. охват поста" value={fmt.short(avgViews)} trend={avgReachTrend} spark={viewsSpark} info={METRIC_DEFS.avgReach} onDrill={() => setDrill('avgReach')} />
        <StatTile label="Реакции" value={fmt.short(totalReactions)} trend={reactionsTrend} spark={reactionsSpark} caption={reactionsCaption} info={METRIC_DEFS.reactions} onDrill={() => setDrill('reactions')} />
        <StatTile
          label="Вовлечённость (ER)"
          value={er > 0 ? er.toFixed(2) + '%' : '—'}
          trend={erTrend}
          spark={engagementSpark}
          caption={erCaption}
          info={METRIC_DEFS.er}
          onDrill={() => setDrill('er')}
        />
      </div>

      {drill && (
        <KpiDrillDown
          metricKey={drill}
          posts={normPosts}
          subsSeries={subsSpark}
          total={drillMeta[drill].total}
          trend={drillMeta[drill].trend}
          caption={drillMeta[drill].caption}
          members={members}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}

/** A daily metric series for the inline sparklines: aligned day labels + values. */
interface DailySeries {
  labels: string[];
  values: number[];
}

interface FeaturedKpiProps {
  label: string;
  value: string;
  trend?: MetricDelta | null;
  caption?: string | null;
  spark?: DailySeries;
  info?: MetricDef;
  onDrill?: () => void;
}

/** Hero KPI — the primary metric on the canvas (no card): big number + delta + area sparkline. */
function FeaturedKpi({ label, value, trend, caption, spark, info, onDrill }: FeaturedKpiProps) {
  const [num, unit] = splitUnit(value);
  return (
    <div>
      <div className="flex items-center gap-1 text-xs tracking-wide text-muted-foreground">
        <span>{label}</span>
        {info && <MetricInfo def={info} />}
      </div>
      <div className="mt-2 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2.5">
            <DrillValue label={label} onDrill={onDrill} className="text-[44px] font-semibold leading-none tabular-nums tracking-tight">
              {num}
              {unit ? <span className="text-2xl font-medium text-muted-foreground">{unit}</span> : null}
            </DrillValue>
            <DeltaPill delta={trend} />
          </div>
          {caption ? <div className="mt-2 text-xs text-muted-foreground">{caption}</div> : null}
        </div>
        {spark && spark.values.length > 1 ? (
          <div className="w-full sm:w-1/2 sm:max-w-[440px]">
            <Sparkline
              values={spark.values}
              labels={spark.labels}
              area
              strokeWidth={2}
              interactive
              caption="по дням"
              formatValue={fmt.short}
              className="h-16 w-full"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The KPI number — a real button (keyboard-accessible drill trigger) when onDrill is set. */
function DrillValue({
  label,
  onDrill,
  className,
  children,
}: {
  label: string;
  onDrill?: () => void;
  className: string;
  children: ReactNode;
}) {
  if (!onDrill) return <div className={className}>{children}</div>;
  return (
    <button
      type="button"
      aria-label={`Разбор: ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        onDrill();
      }}
      className={cn(
        'rounded text-left transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        className,
      )}
    >
      {children}
    </button>
  );
}

interface StatTileProps {
  label: string;
  value: string;
  trend?: MetricDelta | null;
  spark?: DailySeries;
  caption?: string | null;
  info?: MetricDef;
  onDrill?: () => void;
}

/**
 * One ledger cell (no card — a hairline-delimited column in the StatTile grid). The grid's
 * gap-px over a bg-border container draws the 1px dividers; the cell sits on the paper canvas.
 */
function StatTile({ label, value, trend, spark, caption, info, onDrill }: StatTileProps) {
  const [num, unit] = splitUnit(value);
  const cell = onDrill
    ? { onClick: onDrill, title: 'Подробный разбор', className: 'cursor-pointer bg-background p-4 transition-colors hover:bg-muted/60' }
    : { className: 'bg-background p-4' };
  return (
    <div {...cell}>
      <div className="flex items-center gap-1 text-[11px] tracking-wide text-muted-foreground">
        <span className="truncate">{label}</span>
        {info && <MetricInfo def={info} />}
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-2">
        <DrillValue label={label} onDrill={onDrill} className="text-2xl font-semibold tabular-nums tracking-tight">
          {num}
          {unit ? <span className="text-base font-medium text-muted-foreground">{unit}</span> : null}
        </DrillValue>
        <DeltaPill delta={trend} subtle />
      </div>
      {spark && spark.values.length > 1 ? (
        <Sparkline
          values={spark.values}
          labels={spark.labels}
          color={sparkColor(trend)}
          interactive
          className="mt-2.5 h-6 w-full"
        />
      ) : null}
      {caption ? (
        <div className="mt-1.5 truncate text-[10px] tabular-nums text-muted-foreground">{caption}</div>
      ) : null}
    </div>
  );
}

function KpiSkeletons() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="p-5">
              <Skeleton className="h-3 w-2/5" />
              <Skeleton className="mt-3 h-9 w-1/2" />
              <Skeleton className="mt-4 h-12 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="p-4">
              <Skeleton className="h-3 w-3/5" />
              <Skeleton className="mt-2 h-7 w-2/3" />
              <Skeleton className="mt-3 h-6 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
