import type { TgFull } from '@/api/schemas';
import { pctDelta } from '@/lib/delta';
import { postMatchesFilters } from '@/lib/dimensions';
import { fmt } from '@/lib/format';
import { deriveKpis } from '@/lib/kpiDerive';
import type { DrillKey, PostMetricField } from '@/lib/kpiDerive';
import { DAY_MS, alignGhost, baselineCoveredByPosts } from '@/lib/metricSeries';
import { normalizeTgPosts } from '@/lib/posts';
import type { NormalizedPost } from '@/lib/posts';
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
  viewsBySourceBreakdown,
  viewsByTypeBreakdown,
  weekdayViewsBreakdown,
  type BreakdownItem,
} from '@/lib/tgAggregations';
import { bucketIgSeries } from '@/lib/igAggregations';
import type { MetricResolver } from '@/lib/widgetMetrics';
import type { WidgetConfig } from '@/lib/widgetConfig';
import {
  COMPARISON_LABEL,
  bucketPostField,
  bucketSubscriberLevels,
  comparisonBaseline,
  effectiveGrain,
  wantsGhostLine,
} from '@/lib/widgetResolver/shared';
import type {
  DataContext,
  WidgetMetricResolver,
  WidgetResult,
} from '@/lib/widgetResolver/types';

const FIELD: Partial<Record<DrillKey, PostMetricField>> = {
  views: 'reach',
  avgReach: 'reach',
  reactions: 'likes',
  forwards: 'shares',
  er: 'eng',
};

function applyFilters(full: TgFull, filters: WidgetConfig['filters']): TgFull {
  if (!filters || filters.length === 0) return full;
  return { ...full, posts: (full.posts ?? []).filter((post) => postMatchesFilters(post, filters)) };
}

function resolveCoreTg(
  drillKey: DrillKey,
  config: WidgetConfig,
  ctx: DataContext,
  out: WidgetResult,
): WidgetResult {
  const tg = ctx.tg;
  if (!tg?.full) return { ...out, empty: true };

  const full = applyFilters(tg.full, config.filters);
  const derived = deriveKpis(full, tg.history, tg.channels, tg.channelId, ctx.days, ctx.range, ctx.inRange);
  const meta = derived.drillMeta[drillKey];
  out.value = meta.total;
  out.delta = meta.trend;
  out.caption = meta.caption;

  if (config.filters?.length) {
    const totals = derived.windowTotals;
    if (drillKey === 'views') out.delta = totals ? pctDelta(totals.current.views, totals.previous.views) : null;
    else if (drillKey === 'reactions') {
      out.delta = totals ? pctDelta(totals.current.reactions, totals.previous.reactions) : null;
    } else if (drillKey === 'forwards') {
      out.delta = totals ? pctDelta(totals.current.forwards, totals.previous.forwards) : null;
    }
  }

  const grain = effectiveGrain(config.grain);
  const winTo = ctx.range ? ctx.range.to : ctx.now;
  const winFrom = ctx.range ? ctx.range.from : ctx.days > 0 ? winTo - (ctx.days - 1) * DAY_MS : null;
  const comparison = config.comparison;
  const comparisonLabel = comparison ? COMPARISON_LABEL[comparison.mode] : undefined;
  const field = FIELD[drillKey];

  if (drillKey === 'subscribers') {
    out.valueRaw = derived.displayMembers;
    const inWindow = derived.historyRows.filter((row) => ctx.inRange(row.day));
    out.series = bucketSubscriberLevels(inWindow, grain);
    out.meta = { ...out.meta, archiveDays: inWindow.filter((row) => row.subscribers != null).length };
    const baseline = wantsGhostLine(comparison)
      ? comparisonBaseline(comparison, winFrom, winTo, grain)
      : null;
    if (baseline) {
      const rows = derived.historyRows.filter((row) => {
        const timestamp = Date.parse(row.day);
        return Number.isFinite(timestamp) && timestamp >= baseline.from && timestamp <= baseline.to;
      });
      const series = bucketSubscriberLevels(rows, grain);
      if (series.length >= 2 && series.length === out.series.length) {
        out.ghost = series.map((point) => point.value);
        out.ghostLabel = comparisonLabel;
      } else {
        out.meta = { ...out.meta, comparisonNote: 'сравнение скрыто — не хватает архива' };
      }
    } else if (comparison && comparison.mode !== 'none' && wantsGhostLine(comparison)) {
      out.meta = { ...out.meta, comparisonNote: 'сравнение недоступно для этого периода' };
    }
    return out;
  }

  if (!field) return out;
  out.valueRaw =
    drillKey === 'avgReach'
      ? derived.avgViews
      : drillKey === 'er'
        ? derived.er
        : derived.normPosts.reduce((sum, post) => sum + Number(post[field] ?? 0), 0);
  out.series = bucketPostField(derived.normPosts, field, winFrom, winTo, grain);
  out.meta = { ...out.meta, samplePosts: derived.normPosts.length };
  const baseline = wantsGhostLine(comparison)
    ? comparisonBaseline(comparison, winFrom, winTo, grain)
    : null;
  const capped = derived.normPostsAll.length >= 100;
  if (
    baseline &&
    baselineCoveredByPosts(
      derived.normPostsAll.map((post) => (post.date ? Date.parse(post.date) : Number.NaN)),
      baseline.from,
      capped,
    )
  ) {
    const baselinePosts = derived.normPostsAll.filter((post) => {
      if (!post.date) return false;
      const timestamp = Date.parse(post.date);
      return Number.isFinite(timestamp) && timestamp >= baseline.from && timestamp <= baseline.to;
    });
    const values = bucketPostField(baselinePosts, field, baseline.from, baseline.to, grain).map(
      (point) => point.value,
    );
    const ghost = alignGhost(values, out.series.length);
    if (ghost.some((value) => value > 0)) {
      out.ghost = ghost;
      out.ghostLabel = comparisonLabel;
    } else {
      out.meta = { ...out.meta, comparisonNote: 'сравнение скрыто — за базовый период пусто' };
    }
  } else if (baseline) {
    out.meta = { ...out.meta, comparisonNote: 'сравнение скрыто — недостаточно истории постов' };
  } else if (comparison && comparison.mode !== 'none' && wantsGhostLine(comparison)) {
    out.meta = { ...out.meta, comparisonNote: 'сравнение недоступно для этого периода' };
  }
  return out;
}

const resolveCore: WidgetMetricResolver = (metric, config, ctx, out) =>
  metric.drillKey ? resolveCoreTg(metric.drillKey, config, ctx, out) : { ...out, empty: true };

const resolveRatio: WidgetMetricResolver = (metric, _config, ctx, out) => {
  const full = ctx.tg?.full;
  const key = metric.id === 'tg.erv' ? 'erv' : metric.id === 'tg.virality' ? 'virality' : null;
  if (!full || !key) return { ...out, empty: true };
  const posts = normalizeTgPosts(full.posts ?? [], full.channel ?? {}).filter((post) => ctx.inRange(post.date));
  const values = posts
    .map((post) => post[key])
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (values.length === 0) return { ...out, empty: true };
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  out.valueRaw = average;
  out.value = `${average.toFixed(1)}%`;
  out.meta = { ...out.meta, samplePosts: values.length };
  return out;
};

const resolveNetGrowth: WidgetMetricResolver = (_metric, config, ctx, out) => {
  const points = netGrowthPoints(ctx.tg?.graphs);
  if (points.length === 0) return { ...out, empty: true };
  const winTo = ctx.range ? ctx.range.to : ctx.now;
  const winFrom = ctx.range ? ctx.range.from : ctx.days > 0 ? winTo - (ctx.days - 1) * DAY_MS : null;
  const since = winFrom ?? Math.min(...points.map((point) => Date.parse(point.day)).filter(Number.isFinite));
  const inWindow = points.filter((point) => {
    const timestamp = Date.parse(point.day);
    return Number.isFinite(timestamp) && timestamp >= since && timestamp <= winTo;
  });
  if (inWindow.length === 0) return { ...out, empty: true };
  out.series = bucketIgSeries(points, since, winTo, effectiveGrain(config.grain));
  const sum = inWindow.reduce((total, point) => total + point.value, 0);
  out.valueRaw = sum;
  out.value = `${sum > 0 ? '+' : sum < 0 ? '−' : ''}${fmt.num(Math.abs(sum))}`;
  out.meta = { ...out.meta, archiveDays: inWindow.length };
  if (config.comparison && config.comparison.mode !== 'none' && wantsGhostLine(config.comparison)) {
    out.meta = { ...out.meta, comparisonNote: 'сравнение пока не поддерживается для этой метрики' };
  }
  return out;
};

type PostBreakdownResolver = (posts: NormalizedPost[]) => BreakdownItem[];
const POST_BREAKDOWN_RESOLVERS: Record<string, PostBreakdownResolver> = {
  'tg.emoji': emojiBreakdown,
  'tg.formatPerf': formatPerfBreakdown,
  'tg.weekdayViews': weekdayViewsBreakdown,
  'tg.postCount': postCountBreakdown,
};

type AggregateBreakdownResolver = (full: TgFull, ctx: DataContext) => BreakdownItem[];
const AGGREGATE_BREAKDOWN_RESOLVERS: Record<string, AggregateBreakdownResolver> = {
  'tg.engagementComposition': (full) => engagementComposition(full.views_summary),
  'tg.viewsByType': (full) => viewsByTypeBreakdown(full.views_summary),
  'tg.viewsBySource': (_full, ctx) => viewsBySourceBreakdown(ctx.tg?.graphs),
  'tg.newFollowersBySource': (_full, ctx) => newFollowersBySourceBreakdown(ctx.tg?.graphs),
  'tg.languages': (_full, ctx) => languagesBreakdown(ctx.tg?.graphs),
  'tg.sentiment': (_full, ctx) => sentimentBreakdown(ctx.tg?.graphs),
  'tg.hours': (_full, ctx) => hoursBreakdown(ctx.tg?.graphs),
  'tg.churn': (_full, ctx) => churnBreakdown(ctx.tg?.graphs),
};

const resolveBreakdown: WidgetMetricResolver = (metric, config, ctx, out) => {
  const full = ctx.tg?.full;
  if (!full) return { ...out, empty: true };
  const postResolver = POST_BREAKDOWN_RESOLVERS[metric.id];
  const aggregateResolver = AGGREGATE_BREAKDOWN_RESOLVERS[metric.id];
  let items: BreakdownItem[];
  if (postResolver) {
    const raw = (full.posts ?? []).filter((post) => postMatchesFilters(post, config.filters));
    const posts = normalizeTgPosts(raw, full.channel ?? {}).filter((post) => ctx.inRange(post.date));
    out.meta = { ...out.meta, samplePosts: posts.length };
    items = postResolver(posts);
  } else if (aggregateResolver) {
    items = aggregateResolver(full, ctx);
    out.meta = { ...out.meta, periodLabel: undefined };
  } else {
    return { ...out, empty: true };
  }
  if (items.length === 0 || items.every((item) => item.value === 0)) return { ...out, empty: true };
  out.breakdown = items;
  if (metric.additive) {
    const sum = items.reduce((total, item) => total + item.value, 0);
    out.valueRaw = sum;
    out.value = metric.unit === 'posts' ? fmt.num(sum) : fmt.short(sum);
  }
  return out;
};

type TgResolver = Extract<MetricResolver, `tg.${string}`>;

export const TG_WIDGET_RESOLVERS: Record<TgResolver, WidgetMetricResolver> = {
  'tg.core': resolveCore,
  'tg.ratio': resolveRatio,
  'tg.netGrowth': resolveNetGrowth,
  'tg.breakdown': resolveBreakdown,
};
