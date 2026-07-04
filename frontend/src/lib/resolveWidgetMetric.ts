// The single metric resolver — `resolveWidgetMetric(config, ctx)` turns a WidgetConfig into a
// normalized WidgetResult, and it is the ONLY place that knows the shapes of the Telegram /
// Instagram payloads. Everything downstream (the S4 renderer) reads a WidgetResult and never
// touches a raw TgFull / IgData again — so «renderer knows nothing about Telegram or Instagram».
//
// It REUSES the established pure logic rather than re-deriving it:
//   - deriveKpis (kpiDerive)              → the reconciled value / delta / caption for the six KPI
//                                           metrics (headline matches the Overview ledger);
//   - comparisonWindow / alignGhost       → the baseline (ghost) window + length alignment (S8);
//   - bucketKeyOf / bucketKeysInWindow     → grain bucketing (day / week / month; S10 extends);
//   - normalizeTgPosts                    → the per-post erv / virality already computed once.
//
// Formatting-free by design: series carry raw bucket KEYS (`YYYY-MM-DD` / `YYYY-MM`), not display
// labels — the renderer formats. `value` is the one exception: it reuses deriveKpis' display string
// so the headline reconciles exactly with the ledger.
//
// SCOPE (S3a): TG core (views / subscribers / avgReach / reactions / forwards / er) as value+series
// +ghost, and the erv / virality value metrics. TG breakdowns/tables (S3b) and IG (S11) resolve to
// `{ empty: true }` for now — the architecture is complete; those paths are filled in later sprints.

import type {
  ChannelsResponse,
  HistoryData,
  IgBreakdowns,
  IgHistoryData,
  IgInsights,
  IgOnline,
  IgProfile,
  TgFull,
  TgGraphs,
} from '@/api/schemas';
import type { DateRange, PeriodDays } from '@/lib/period';
import { pctDelta } from '@/lib/delta';
import type { MetricDelta } from '@/lib/delta';
import type { MetricKind, MetricUnit } from '@/lib/widgetMetrics';
import type { ComparisonConfig, ComparisonMode, WidgetConfig, WidgetGrain } from '@/lib/widgetConfig';
import { getMetric } from '@/lib/widgetMetrics';
import { deriveKpis } from '@/lib/kpiDerive';
import type { DrillKey, PostMetricField } from '@/lib/kpiDerive';
import { normalizeTgPosts } from '@/lib/posts';
import type { NormalizedPost } from '@/lib/posts';
import { postMatchesFilters } from '@/lib/dimensions';
import { DAY_MS, alignGhost, baselineCoveredByPosts, bucketKeyOf, bucketKeysInWindow, comparisonWindow } from '@/lib/metricSeries';
import type { SeriesGrain } from '@/lib/metricSeries';
import { fmt } from '@/lib/format';
import {
  churnBreakdown,
  emojiBreakdown,
  engagementComposition,
  formatPerfBreakdown,
  hoursBreakdown,
  languagesBreakdown,
  netGrowthPoints,
  newFollowersBySourceBreakdown,
  postCountBreakdown,
  sentimentBreakdown,
  viewsByTypeBreakdown,
  viewsBySourceBreakdown,
  weekdayViewsBreakdown,
  type BreakdownItem,
} from '@/lib/tgAggregations';
import {
  bucketIgSeries,
  igAgeBreakdown,
  igCitiesBreakdown,
  igCountriesBreakdown,
  igFormatsBreakdown,
  igGenderBreakdown,
  igHoursBreakdown,
  igNetFollowerPoints,
  igSeriesPoints,
  igWindowValue,
} from '@/lib/igAggregations';

export interface WidgetSeriesPoint {
  /** Bucket key — `YYYY-MM-DD` (day/week Monday) or `YYYY-MM` (month). The renderer formats it. */
  date: string;
  value: number;
}
export interface WidgetBreakdownItem {
  label: string;
  value: number;
  display?: string;
  color?: string;
}
export interface WidgetLedgerRow {
  label: string;
  value: string;
}

export interface WidgetResult {
  metricId: string;
  kind: MetricKind;
  unit: MetricUnit;
  /** Display-ready headline (reconciled with deriveKpis for the core metrics). */
  value?: string;
  /** Raw scalar behind `value` — for target / progress math (S9). */
  valueRaw?: number;
  delta?: MetricDelta | null;
  caption?: string | null;
  series?: WidgetSeriesPoint[];
  /** Aligned comparison (baseline) series, same length as `series` (S8). */
  ghost?: number[];
  ghostLabel?: string;
  breakdown?: WidgetBreakdownItem[];
  rows?: WidgetLedgerRow[];
  /** Goal value for the widget's charts (S9) — a number the LineChart/BarChart draw as a dashed line. */
  target?: number;
  /** Progress toward the target as a percentage of it («68% от цели»), when both are known. */
  targetPct?: number;
  /** True when the resolver has no data path for this metric yet (S3b / S11 stubs, or missing data). */
  empty?: boolean;
}

/** Already-loaded TG payloads + the active channel (no fetching happens here). */
export interface TgDataContext {
  full?: TgFull;
  history?: HistoryData;
  channels?: ChannelsResponse;
  /** The nested analytics graphs payload (useTgGraphs) — sources / languages / sentiment / hours /
   *  followers. Period-agnostic (server window), like the existing TG analytics widgets. */
  graphs?: TgGraphs;
  channelId: number | null;
}

/** Already-loaded Instagram payloads (useIgProfile / useIgInsights / useIgBreakdowns / useIgOnline /
 *  useIgHistory). The IG window (since/until) is derived from the ctx window below, mirroring
 *  useIgData (IG insights cap at ~90 days). */
export interface IgDataContext {
  profile?: IgProfile;
  insights?: IgInsights;
  breakdowns?: IgBreakdowns;
  online?: IgOnline;
  history?: IgHistoryData;
}

/**
 * Everything the resolver needs, pre-resolved by the render layer:
 *   - `now` / `days` / `range` / `inRange` describe the widget's EFFECTIVE window (the render layer
 *     has already folded in config.period), so the resolver stays pure + deterministic (tests pass a
 *     fixed `now`; nothing calls Date.now() in here);
 *   - `tg` / `ig` are the already-fetched payloads (useTgFull / useHistory / useIgData hooks).
 */
export interface DataContext {
  now: number;
  days: PeriodDays;
  range: DateRange | null;
  inRange: (dateISO: string | null | undefined) => boolean;
  tg?: TgDataContext;
  ig?: IgDataContext;
}

// Which NormalizedPost field a core series sums (mirrors MetricPage's FIELD; subscribers has none).
const FIELD: Partial<Record<DrillKey, PostMetricField>> = {
  views: 'reach',
  avgReach: 'reach',
  reactions: 'likes',
  forwards: 'shares',
  er: 'eng',
};

// ── Comparison (S8): the baseline window + how it's displayed, as a full model setting ──────────
const COMPARISON_LABEL: Record<ComparisonMode, string> = {
  none: '',
  previous_period: 'прошлый период',
  same_period_last_month: 'прошлый месяц',
  same_period_last_year: 'год назад',
  custom: 'выбранный период',
};

/** Shift an instant back/forward by whole calendar months (UTC), clamping the day so month-end never
 *  overflows (Mar-31 − 1mo → Feb-28, not Mar-03). Used for the month-shift baseline under CALENDAR
 *  grains, where a fixed 30-day shift would land on a different bucket count than the active window. */
function shiftMonthsUTC(ms: number, months: number): number {
  const d = new Date(ms);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const maxDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, maxDay));
  return d.getTime();
}

/** The baseline window for a comparison config, or null when there's nothing to compare against.
 *  `custom` uses the explicit from/to; the others shift the active [winFrom..winTo] window. The month
 *  shift is grain-aware: a fixed 30-day shift keeps day-for-day alignment for day/week grains, but a
 *  CALENDAR-month shift is needed for month/quarter/year so the baseline lands on the same bucket
 *  count one position back (else alignGhost would overlay the wrong month). */
function comparisonBaseline(
  cmp: ComparisonConfig | undefined,
  winFrom: number | null,
  winTo: number,
  grain: SeriesGrain,
): { from: number; to: number } | null {
  if (!cmp || cmp.mode === 'none') return null;
  if (cmp.mode === 'custom') return cmp.from != null && cmp.to != null ? { from: cmp.from, to: cmp.to } : null;
  if (winFrom == null) return null; // «Всё» has no shiftable window
  if (cmp.mode === 'previous_period') return comparisonWindow(winFrom, winTo, 'prev');
  if (cmp.mode === 'same_period_last_year') return comparisonWindow(winFrom, winTo, 'year');
  if (cmp.mode === 'same_period_last_month') {
    if (grain === 'month' || grain === 'quarter' || grain === 'year') {
      return { from: shiftMonthsUTC(winFrom, -1), to: shiftMonthsUTC(winTo, -1) };
    }
    const shift = 30 * DAY_MS; // day/week: fixed shift keeps day-for-day alignment
    return { from: winFrom - shift, to: winTo - shift };
  }
  return null;
}

/** Whether the comparison should draw the ghost LINE. `display:'delta'` shows only the pill (the
 *  line is hidden), so «Дельта» is a real choice, not a no-op. Default (undefined) = draw the line. */
function wantsGhostLine(cmp: ComparisonConfig | undefined): boolean {
  return (cmp?.display ?? 'ghost_line') !== 'delta';
}

/** Config grain → the metricSeries bucketing grain (day/week/month/quarter/year; day fallback). */
function effGrain(grain: WidgetGrain | undefined): SeriesGrain {
  return grain === 'week' || grain === 'month' || grain === 'quarter' || grain === 'year' ? grain : 'day';
}

/** Zero-filled per-bucket sums of a post field over [winFrom..winTo] (raw keys; «Всё» = sparse). */
function bucketPostField(
  posts: NormalizedPost[],
  field: PostMetricField,
  winFrom: number | null,
  winTo: number,
  grain: SeriesGrain,
): WidgetSeriesPoint[] {
  const by = new Map<string, number>();
  for (const p of posts) {
    if (!p.date) continue;
    const t = Date.parse(p.date);
    if (!Number.isFinite(t)) continue;
    const k = bucketKeyOf(t, grain);
    by.set(k, (by.get(k) ?? 0) + Number(p[field] ?? 0));
  }
  const keys = winFrom != null ? bucketKeysInWindow(winFrom, winTo, grain) : [...by.keys()].sort();
  return keys.map((k) => ({ date: k, value: by.get(k) ?? 0 }));
}

/** Subscriber LEVEL per bucket (last archive value inside the bucket) — sparse, data-only keys. */
function bucketSubsLevel(
  rows: { day: string; subscribers?: number | null }[],
  grain: SeriesGrain,
): WidgetSeriesPoint[] {
  const by = new Map<string, number>();
  rows
    .filter((r) => r.subscribers != null)
    .sort((a, b) => a.day.localeCompare(b.day))
    .forEach((r) => {
      const t = Date.parse(r.day);
      if (Number.isFinite(t)) by.set(bucketKeyOf(t, grain), Number(r.subscribers)); // later rows overwrite = last
    });
  return [...by.keys()].sort().map((k) => ({ date: k, value: by.get(k)! }));
}

function base(metricId: string, kind: MetricKind, unit: MetricUnit): WidgetResult {
  return { metricId, kind, unit };
}

/** Apply the widget's per-post filters (S7) to a TgFull's posts — the resolver filters the already-
 *  fetched posts client-side, so a metric aggregates only the matching subset. No-op without filters. */
function applyFilters(full: TgFull, filters: WidgetConfig['filters']): TgFull {
  if (!filters || filters.length === 0) return full;
  return { ...full, posts: (full.posts ?? []).filter((p) => postMatchesFilters(p, filters)) };
}

/** The six KPI metrics: value/delta/caption from deriveKpis, plus a grain-bucketed series + ghost. */
function resolveCoreTg(
  drillKey: DrillKey,
  config: WidgetConfig,
  ctx: DataContext,
  out: WidgetResult,
): WidgetResult {
  const tg = ctx.tg;
  if (!tg?.full) return { ...out, empty: true };

  // Per-post filters (S7) narrow the posts BEFORE deriveKpis, so value / delta / series / normPosts
  // all reconcile to the filtered subset. Subscribers (level, no post attribution) declares no
  // dimensions, so it's never filtered.
  const full = applyFilters(tg.full, config.filters);
  const derived = deriveKpis(full, tg.history, tg.channels, tg.channelId, ctx.days, ctx.range, ctx.inRange);
  const meta = derived.drillMeta[drillKey];
  out.value = meta.total;
  out.delta = meta.trend;
  out.caption = meta.caption;

  // Per-post filters: value/caption/series reconcile to the filtered subset, but the KPI trend for
  // views/reactions/forwards is archive-derived (the day snapshot has no per-post attribution, so it
  // reflects the WHOLE channel). Recompute it from the filtered post windows (windowTotals is over the
  // filtered posts) — or SUPPRESS it when there's no paired post window, rather than leave the stale
  // whole-channel delta beside a filtered headline. avgReach's trend is already post-derived
  // (avgReachWindowDelta over the filtered posts); subscribers/er expose no dimensions (never filtered).
  if (config.filters?.length) {
    const wt = derived.windowTotals;
    if (drillKey === 'views') out.delta = wt ? pctDelta(wt.current.views, wt.previous.views) : null;
    else if (drillKey === 'reactions') out.delta = wt ? pctDelta(wt.current.reactions, wt.previous.reactions) : null;
    else if (drillKey === 'forwards') out.delta = wt ? pctDelta(wt.current.forwards, wt.previous.forwards) : null;
  }

  const grain = effGrain(config.grain);
  const winTo = ctx.range ? ctx.range.to : ctx.now;
  const winFrom = ctx.range ? ctx.range.from : ctx.days > 0 ? winTo - (ctx.days - 1) * DAY_MS : null;

  const cmp = config.comparison;
  const cmpLabel = cmp ? COMPARISON_LABEL[cmp.mode] : undefined;
  const field = FIELD[drillKey];
  if (drillKey === 'subscribers') {
    out.valueRaw = derived.displayMembers;
    const inWin = derived.historyRows.filter((r) => ctx.inRange(r.day));
    out.series = bucketSubsLevel(inWin, grain);
    const baseWin = wantsGhostLine(cmp) ? comparisonBaseline(cmp, winFrom, winTo, grain) : null;
    if (baseWin) {
      const baseRows = derived.historyRows.filter((r) => {
        const t = Date.parse(r.day);
        return Number.isFinite(t) && t >= baseWin.from && t <= baseWin.to;
      });
      const gseries = bucketSubsLevel(baseRows, grain);
      if (gseries.length >= 2 && gseries.length === out.series.length) {
        out.ghost = gseries.map((p) => p.value);
        out.ghostLabel = cmpLabel;
      }
    }
  } else if (field) {
    out.valueRaw =
      drillKey === 'avgReach'
        ? derived.avgViews
        : drillKey === 'er'
          ? derived.er
          : derived.normPosts.reduce((s, p) => s + Number(p[field] ?? 0), 0);
    out.series = bucketPostField(derived.normPosts, field, winFrom, winTo, grain);
    const baseWin = wantsGhostLine(cmp) ? comparisonBaseline(cmp, winFrom, winTo, grain) : null;
    // Only draw the baseline ghost when the sum over it is COMPLETE. The post fetch server-caps at
    // 100 (useTgFull windowPair), so a long (e.g. 90д) prev/year baseline can start before the oldest
    // loaded post → the per-post sum undercounts and the dashed line reads as a misleading near-zero
    // baseline (same root cause as the metric page's +969% rail). `capped` = the fetch hit that cap
    // (more posts exist); when it didn't, we have all posts and never over-suppress a sparse channel.
    const capped = derived.normPostsAll.length >= 100;
    if (
      baseWin &&
      baselineCoveredByPosts(derived.normPostsAll.map((p) => (p.date ? Date.parse(p.date) : NaN)), baseWin.from, capped)
    ) {
      const postsInBase = derived.normPostsAll.filter((p) => {
        if (!p.date) return false;
        const t = Date.parse(p.date);
        return Number.isFinite(t) && t >= baseWin.from && t <= baseWin.to;
      });
      const graw = bucketPostField(postsInBase, field, baseWin.from, baseWin.to, grain).map((p) => p.value);
      const gv = alignGhost(graw, out.series.length);
      if (gv.some((v) => v > 0)) {
        out.ghost = gv;
        out.ghostLabel = cmpLabel;
      }
    }
  }
  return out;
}

/** erv / virality — a per-post-average percentage (already computed on NormalizedPost). */
function resolveTgRatio(metricId: 'tg.erv' | 'tg.virality', ctx: DataContext, out: WidgetResult): WidgetResult {
  const full = ctx.tg?.full;
  if (!full) return { ...out, empty: true };
  const posts = normalizeTgPosts(full.posts ?? [], full.channel ?? {}).filter((p) => ctx.inRange(p.date));
  const key = metricId === 'tg.erv' ? 'erv' : 'virality';
  const vals = posts.map((p) => p[key]).filter((v): v is number => v !== null && Number.isFinite(v));
  if (vals.length === 0) return { ...out, empty: true };
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  out.valueRaw = avg;
  out.value = `${avg.toFixed(1)}%`;
  return out;
}

/** The metric dispatch (source/kind → the right resolver). Wrapped by resolveWidgetMetric, which
 *  layers the target/progress (S9) on top. */
function resolveMetricCore(config: WidgetConfig, ctx: DataContext): WidgetResult {
  const metric = getMetric(config.metricId);
  if (!metric) return { ...base(config.metricId, 'value', 'number'), empty: true };

  const out = base(metric.id, metric.kind, metric.unit);

  if (metric.source === 'ig') return resolveIg(metric.id, config, ctx, out);

  if (metric.drillKey) return resolveCoreTg(metric.drillKey, config, ctx, out);
  if (metric.id === 'tg.erv' || metric.id === 'tg.virality') return resolveTgRatio(metric.id, ctx, out);
  if (metric.id === 'tg.netGrowth') return resolveTgNetGrowth(config, ctx, out);
  if (metric.kind === 'breakdown') return resolveTgBreakdown(metric.id, config, ctx, out);

  // Tables (tg.weeklyTable / tg.topPosts) are served by the report/analytics surfaces, not the
  // story-card builder (a rich table doesn't fit a widget tile) — the catalogue hides table-kind.
  return { ...out, empty: true };
}

/** The effective goal value for a target config (S9): fixed → its value; dynamic → the current value
 *  of another (same-source) metric; forecast is a follow-up (needs projection semantics). null when
 *  there's no usable target. */
function resolveTargetValue(config: WidgetConfig, ctx: DataContext): number | null {
  const t = config.target;
  if (!t) return null;
  if (t.type === 'fixed') return t.value != null && Number.isFinite(t.value) && t.value > 0 ? t.value : null;
  if (t.type === 'dynamic' && t.metricId && t.metricId !== config.metricId) {
    const tm = getMetric(t.metricId);
    const cm = getMetric(config.metricId);
    // Same source only — a widget body carries one source's payloads (ctx.tg XOR ctx.ig).
    if (tm && cm && tm.source === cm.source) {
      const r = resolveMetricCore({ id: 'target', metricId: t.metricId, viz: tm.defaultViz }, ctx);
      return typeof r.valueRaw === 'number' && Number.isFinite(r.valueRaw) && r.valueRaw > 0 ? r.valueRaw : null;
    }
  }
  return null; // forecast — deferred
}

/**
 * Resolve one widget config against the loaded data. Never throws — an unknown metric, a missing
 * payload or a not-yet-wired path returns `{ empty: true }` so the renderer shows an honest empty
 * state instead of crashing. Layers the target goal line + «N% от цели» progress (S9) on top.
 */
export function resolveWidgetMetric(config: WidgetConfig, ctx: DataContext): WidgetResult {
  const result = resolveMetricCore(config, ctx);
  if (!result.empty && config.target) {
    const target = resolveTargetValue(config, ctx);
    if (target != null) {
      result.target = target;
      if (typeof result.valueRaw === 'number' && Number.isFinite(result.valueRaw)) {
        result.targetPct = (result.valueRaw / target) * 100;
      }
    }
  }
  return result;
}

/** «Чистый прирост подписчиков» — net daily (joined − left) from the followers graph, bucketed to
 *  the widget's window + grain (flow: SUM per bucket). Period-windowed like the metric-page series. */
function resolveTgNetGrowth(config: WidgetConfig, ctx: DataContext, out: WidgetResult): WidgetResult {
  const points = netGrowthPoints(ctx.tg?.graphs);
  if (points.length === 0) return { ...out, empty: true };
  const winTo = ctx.range ? ctx.range.to : ctx.now;
  const winFrom = ctx.range ? ctx.range.from : ctx.days > 0 ? winTo - (ctx.days - 1) * DAY_MS : null;
  // «Всё» → since = earliest dated net point (the graph is a bounded server window anyway).
  const since = winFrom ?? Math.min(...points.map((p) => Date.parse(p.day)).filter((t) => Number.isFinite(t)));
  const inWin = points.filter((p) => {
    const t = Date.parse(p.day);
    return Number.isFinite(t) && t >= since && t <= winTo;
  });
  if (inWin.length === 0) return { ...out, empty: true };
  const grain = effGrain(config.grain);
  out.series = bucketIgSeries(points, since, winTo, grain); // generic {day,value} flow bucketer
  const sum = inWin.reduce((s, p) => s + p.value, 0);
  out.valueRaw = sum;
  out.value = `${sum > 0 ? '+' : sum < 0 ? '−' : ''}${fmt.num(Math.abs(sum))}`;
  return out;
}

/** TG categorical splits — dispatched to the pure aggregators in tgAggregations. Post-derived
 *  metrics window the fetched posts by ctx.inRange; summary/graphs metrics are period-agnostic
 *  (server aggregates), matching the existing analytics widgets. */
function resolveTgBreakdown(metricId: string, config: WidgetConfig, ctx: DataContext, out: WidgetResult): WidgetResult {
  const tg = ctx.tg;
  if (!tg?.full) return { ...out, empty: true };
  // Post-derived breakdowns honour the per-post filters (S7); summary/graphs breakdowns are aggregates
  // with no per-post attribution, so filters don't apply to them (the editor won't offer filters there).
  const full = tg.full;

  let items: BreakdownItem[];
  switch (metricId) {
    case 'tg.emoji':
    case 'tg.formatPerf':
    case 'tg.weekdayViews':
    case 'tg.postCount': {
      const raw = (full.posts ?? []).filter((p) => postMatchesFilters(p, config.filters));
      const posts = normalizeTgPosts(raw, full.channel ?? {}).filter((p) => ctx.inRange(p.date));
      items =
        metricId === 'tg.emoji'
          ? emojiBreakdown(posts)
          : metricId === 'tg.formatPerf'
            ? formatPerfBreakdown(posts)
            : metricId === 'tg.weekdayViews'
              ? weekdayViewsBreakdown(posts)
              : postCountBreakdown(posts);
      break;
    }
    case 'tg.engagementComposition':
      items = engagementComposition(full.views_summary);
      break;
    case 'tg.viewsByType':
      items = viewsByTypeBreakdown(full.views_summary);
      break;
    case 'tg.viewsBySource':
      items = viewsBySourceBreakdown(tg.graphs);
      break;
    case 'tg.newFollowersBySource':
      items = newFollowersBySourceBreakdown(tg.graphs);
      break;
    case 'tg.languages':
      items = languagesBreakdown(tg.graphs);
      break;
    case 'tg.sentiment':
      items = sentimentBreakdown(tg.graphs);
      break;
    case 'tg.hours':
      items = hoursBreakdown(tg.graphs);
      break;
    case 'tg.churn':
      items = churnBreakdown(tg.graphs);
      break;
    default:
      return { ...out, empty: true };
  }

  // A breakdown that is empty OR all-zero (e.g. no posts on any weekday) is «no data».
  if (items.length === 0 || items.every((i) => i.value === 0)) return { ...out, empty: true };
  out.breakdown = items;
  return out;
}

/** Resolve an Instagram metric. The IG window (since/until, capped ~90d) is derived from the ctx
 *  window exactly as useIgData does; series flows SUM per bucket, demographics are period-agnostic
 *  server aggregates (a follower snapshot, not a windowed count). */
function resolveIg(metricId: string, config: WidgetConfig, ctx: DataContext, out: WidgetResult): WidgetResult {
  const ig = ctx.ig;
  if (!ig) return { ...out, empty: true };

  const until = ctx.range ? ctx.range.to : ctx.now;
  const windowDays = ctx.range
    ? Math.min(90, Math.max(1, Math.ceil((ctx.range.to - ctx.range.from) / DAY_MS)))
    : ctx.days > 0
      ? Math.min(ctx.days, 90)
      : 90;
  const since = ctx.range ? ctx.range.from : until - windowDays * DAY_MS;
  const grain = effGrain(config.grain);

  /** Comparison ghost (S8) for an IG flow series — the baseline window's bucketed series, aligned to
   *  the active series length. Honours display ('delta' → no line) and every mode (prev/year/month/
   *  custom). Kept a no-op when there's no comparison, so it's shared by every IG series metric. */
  const applyIgGhost = (points: { day: string; value: number }[], opts?: { allowZero?: boolean }) => {
    if (!out.series || !wantsGhostLine(config.comparison)) return;
    const baseWin = comparisonBaseline(config.comparison, since, until, grain);
    if (!baseWin) return;
    const graw = bucketIgSeries(points, baseWin.from, baseWin.to, grain).map((p) => p.value);
    const gv = alignGhost(graw, out.series.length);
    // Net-follower series can legitimately net to 0 across every bucket from REAL activity, so gate on
    // baseline data-presence (hasCur) not value; a non-negative flow (reach/interactions) with an
    // all-zero baseline genuinely IS no data, so it keeps the value gate.
    const show = opts?.allowZero
      ? igWindowValue(points, baseWin.from, baseWin.to).hasCur
      : gv.some((v) => v !== 0);
    if (show) {
      out.ghost = gv;
      out.ghostLabel = config.comparison ? COMPARISON_LABEL[config.comparison.mode] : undefined;
    }
  };

  /** A windowed flow series (reach / interactions): value + delta + grain-bucketed series + ghost. */
  const flowSeries = (name: string): WidgetResult => {
    const points = igSeriesPoints(ig.insights, ig.history, name);
    const { cur, delta } = igWindowValue(points, since, until);
    out.series = bucketIgSeries(points, since, until, grain);
    out.valueRaw = cur;
    out.value = fmt.short(cur);
    out.delta = delta;
    applyIgGhost(points);
    if (out.series.every((p) => p.value === 0) && cur === 0) return { ...out, empty: true };
    return out;
  };

  switch (metricId) {
    case 'ig.reach':
      return flowSeries('reach');
    case 'ig.interactions':
      return flowSeries('total_interactions');
    case 'ig.netFollowers': {
      const points = igNetFollowerPoints(ig.insights);
      const { cur, hasCur } = igWindowValue(points, since, until);
      // hasCur (not series-length) is the real «no data» signal: bucketKeysInWindow always yields ≥1
      // bucket, so a length check is dead. This mirrors the AudienceMovement panel / netMovement.hasCur
      // — a genuine net-zero (follows==unfollows) has hasCur=true and legitimately shows «0».
      if (!hasCur) return { ...out, empty: true };
      out.series = bucketIgSeries(points, since, until, grain);
      out.valueRaw = cur;
      out.value = `${cur > 0 ? '+' : cur < 0 ? '−' : ''}${fmt.num(Math.abs(cur))}`;
      applyIgGhost(points, { allowZero: true }); // net-zero across buckets is real data, not «no ghost»
      return out;
    }
    case 'ig.followers': {
      const count = Number(ig.profile?.followers_count ?? 0);
      if (!count) return { ...out, empty: true };
      out.valueRaw = count;
      out.value = fmt.num(count);
      return out;
    }
    case 'ig.erv': {
      const reach = igWindowValue(igSeriesPoints(ig.insights, ig.history, 'reach'), since, until).cur;
      const ti = igWindowValue(igSeriesPoints(ig.insights, ig.history, 'total_interactions'), since, until).cur;
      if (reach <= 0) return { ...out, empty: true };
      const er = (ti / reach) * 100;
      out.valueRaw = er;
      out.value = `${er.toFixed(1)}%`;
      return out;
    }
    default:
      return resolveIgBreakdown(metricId, ig, out);
  }
}

/** Instagram categorical splits — demographics (age/gender/country/city), content formats, and
 *  followers-online by hour. All period-agnostic server aggregates. */
function resolveIgBreakdown(metricId: string, ig: IgDataContext, out: WidgetResult): WidgetResult {
  let items: BreakdownItem[];
  switch (metricId) {
    case 'ig.formats':
      items = igFormatsBreakdown(ig.breakdowns);
      break;
    case 'ig.age':
      items = igAgeBreakdown(ig.breakdowns);
      break;
    case 'ig.gender':
      items = igGenderBreakdown(ig.breakdowns);
      break;
    case 'ig.countries':
      items = igCountriesBreakdown(ig.breakdowns);
      break;
    case 'ig.cities':
      items = igCitiesBreakdown(ig.breakdowns);
      break;
    case 'ig.hours':
      items = igHoursBreakdown(ig.online);
      break;
    default:
      return { ...out, empty: true };
  }
  if (items.length === 0 || items.every((i) => i.value === 0)) return { ...out, empty: true };
  out.breakdown = items;
  return out;
}
