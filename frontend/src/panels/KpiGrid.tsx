import { useChannels, useHistory, useTgFull } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { fmt } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Sparkline } from '@/components/Sparkline';
import { Skeleton } from '@/components/ui/skeleton';
import { usePeriod } from '@/lib/period';
import { avgReachWindowDelta, dailyWindowDelta, pctDelta, subscriberChange, subscriberDelta, sumPostWindows } from '@/lib/delta';
import type { MetricDelta } from '@/lib/delta';

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
  const forwardsSpark = dailySeries((post) => Number(post.forwards ?? 0));
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

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FeaturedKpi
          label="Просмотры за период"
          value={fmt.short(totalViews)}
          trend={viewsTrend}
          caption={viewsCaption}
          spark={viewsSpark}
        />
        <FeaturedKpi label="Подписчики" value={fmt.num(displayMembers)} trend={subscriberTrend} caption={subCaption} spark={subsSpark} />
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Ср. охват поста" value={fmt.short(avgViews)} trend={avgReachTrend} spark={viewsSpark} />
        <StatTile label="Реакции" value={fmt.short(totalReactions)} trend={reactionsTrend} spark={reactionsSpark} caption={reactionsCaption} />
        <StatTile label="Репосты" value={fmt.short(totalForwards)} trend={forwardsTrend} spark={forwardsSpark} caption={forwardsCaption} />
        <StatTile
          label="Вовлечённость (ER)"
          value={er > 0 ? er.toFixed(2) + '%' : '—'}
          trend={erTrend}
          spark={engagementSpark}
          caption={erCaption}
        />
      </div>
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
}

function FeaturedKpi({ label, value, trend, caption, spark }: FeaturedKpiProps) {
  const [num, unit] = splitUnit(value);
  return (
    <Card>
      <CardContent className="relative overflow-hidden p-5">
        <div className="text-xs tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-2 flex items-baseline gap-2.5">
          <div className="text-4xl font-semibold tabular-nums tracking-tight">
            {num}
            {unit ? <span className="font-medium text-muted-foreground">{unit}</span> : null}
          </div>
          <DeltaPill delta={trend} />
        </div>
        {caption ? <div className="mt-1.5 text-xs text-muted-foreground">{caption}</div> : null}
        {spark && spark.values.length > 1 ? (
          <div className="mt-4">
            <Sparkline
              values={spark.values}
              labels={spark.labels}
              area
              strokeWidth={2}
              interactive
              caption="по дням"
              formatValue={fmt.short}
              className="h-12 w-full"
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

interface StatTileProps {
  label: string;
  value: string;
  trend?: MetricDelta | null;
  spark?: DailySeries;
  caption?: string | null;
}

function StatTile({ label, value, trend, spark, caption }: StatTileProps) {
  const [num, unit] = splitUnit(value);
  return (
    <Card>
      <CardContent className="p-4">
        <div className="truncate text-[11px] tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-1.5 flex items-baseline justify-between gap-2">
          <div className="text-2xl font-semibold tabular-nums tracking-tight">
            {num}
            {unit ? <span className="text-base font-medium text-muted-foreground">{unit}</span> : null}
          </div>
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
      </CardContent>
    </Card>
  );
}

function DeltaPill({ delta, subtle = false }: { delta?: MetricDelta | null; subtle?: boolean }) {
  if (!delta || delta.dir === 'flat') return null;
  const direction = delta.dir === 'up' ? '↑' : '↓';
  const color = delta.dir === 'up' ? 'text-verdant' : 'text-ember';
  const percentage = delta.pct >= 100 ? delta.pct.toFixed(0) : delta.pct.toFixed(1);
  if (subtle) {
    return (
      <span className={`shrink-0 text-xs font-semibold tabular-nums ${color}`}>
        {direction}
        {percentage}%
      </span>
    );
  }
  // Trend-tinted chip (not bg-muted, which is ~invisible on the white light-theme card).
  const chip = delta.dir === 'up' ? 'text-verdant bg-verdant/10' : 'text-ember bg-ember/10';
  return (
    <span className={`rounded-full ${chip} px-2 py-0.5 text-xs font-semibold tabular-nums`}>
      {direction}
      {percentage}%
    </span>
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
