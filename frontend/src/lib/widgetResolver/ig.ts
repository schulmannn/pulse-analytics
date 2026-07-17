import { fmt } from '@/lib/format';
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
import { followerLevelSeries } from '@/lib/igMetrics';
import { DAY_MS, alignGhost } from '@/lib/metricSeries';
import {
  COMPARISON_LABEL,
  bucketSubscriberLevels,
  comparisonBaseline,
  effectiveGrain,
  wantsGhostLine,
} from '@/lib/widgetResolver/shared';
import type {
  IgDataContext,
  WidgetBreakdownItem,
  WidgetMetricResolver,
} from '@/lib/widgetResolver/types';

const FLOW_SERIES: Record<string, string> = {
  'ig.reach': 'reach',
  'ig.interactions': 'total_interactions',
};

type IgBreakdownResolver = (ig: IgDataContext) => WidgetBreakdownItem[];
const BREAKDOWN_RESOLVERS: Record<string, IgBreakdownResolver> = {
  'ig.formats': (ig) => igFormatsBreakdown(ig.breakdowns),
  'ig.age': (ig) => igAgeBreakdown(ig.breakdowns),
  'ig.gender': (ig) => igGenderBreakdown(ig.breakdowns),
  'ig.countries': (ig) => igCountriesBreakdown(ig.breakdowns),
  'ig.cities': (ig) => igCitiesBreakdown(ig.breakdowns),
  'ig.hours': (ig) => igHoursBreakdown(ig.online),
};

export const resolveIgMetric: WidgetMetricResolver = (metric, config, ctx, out) => {
  const ig = ctx.ig;
  if (!ig) return { ...out, empty: true };

  const until = ctx.range ? ctx.range.to : ctx.now;
  const windowDays = ctx.range
    ? Math.min(90, Math.max(1, Math.ceil((ctx.range.to - ctx.range.from) / DAY_MS)))
    : ctx.days > 0
      ? Math.min(ctx.days, 90)
      : 90;
  const since = ctx.range ? ctx.range.from : until - windowDays * DAY_MS;
  const grain = effectiveGrain(config.grain);
  if (ctx.days === 0 && !ctx.range) out.meta = { ...out.meta, periodLabel: 'за 90 дн.' };

  const applyGhost = (points: { day: string; value: number }[], allowZero = false) => {
    if (!out.series || !wantsGhostLine(config.comparison)) return;
    const baseline = comparisonBaseline(config.comparison, since, until, grain);
    if (!baseline) return;
    const values = bucketIgSeries(points, baseline.from, baseline.to, grain).map((point) => point.value);
    const ghost = alignGhost(values, out.series.length);
    const show = allowZero
      ? igWindowValue(points, baseline.from, baseline.to).hasCur
      : ghost.some((value) => value !== 0);
    if (show) {
      out.ghost = ghost;
      out.ghostLabel = config.comparison ? COMPARISON_LABEL[config.comparison.mode] : undefined;
    } else {
      out.meta = { ...out.meta, comparisonNote: 'сравнение скрыто — за базовый период пусто' };
    }
  };

  const flowName = FLOW_SERIES[metric.id];
  if (flowName) {
    const points = igSeriesPoints(ig.insights, ig.history, flowName);
    const { cur, delta } = igWindowValue(points, since, until);
    out.series = bucketIgSeries(points, since, until, grain);
    out.valueRaw = cur;
    out.value = fmt.short(cur);
    out.delta = delta;
    applyGhost(points);
    return out.series.every((point) => point.value === 0) && cur === 0 ? { ...out, empty: true } : out;
  }

  if (metric.id === 'ig.netFollowers') {
    const points = igNetFollowerPoints(ig.insights);
    const { cur, hasCur } = igWindowValue(points, since, until);
    if (!hasCur) return { ...out, empty: true };
    out.series = bucketIgSeries(points, since, until, grain);
    out.valueRaw = cur;
    out.value = `${cur > 0 ? '+' : cur < 0 ? '−' : ''}${fmt.num(Math.abs(cur))}`;
    applyGhost(points, true);
    return out;
  }

  if (metric.id === 'ig.followers') {
    const count = Number(ig.profile?.followers_count ?? 0);
    // Level-серия базы «как у ТГ Подписчиков»: якоря ig_daily.followers_total + реконструкция по
    // net (follows − unfollows) + живое число профиля сегодняшней точкой (followerLevelSeries —
    // тот же движок, что на странице метрики). Bucket — ПОСЛЕДНИЙ уровень бакета, не сумма потока.
    // Раньше карточка отдавала только число без серии — на Главной это выглядело «графика нет».
    const levelPoints = followerLevelSeries(ig.history?.rows, count || null);
    const inWindow = levelPoints
      .filter((p) => {
        const timestamp = Date.parse(p.day);
        return Number.isFinite(timestamp) && timestamp >= since && timestamp <= until;
      })
      .map((p) => ({ day: p.day, subscribers: p.value }));
    if (!count && !inWindow.length) return { ...out, empty: true };
    if (inWindow.length >= 2) {
      out.series = bucketSubscriberLevels(inWindow, grain);
      out.meta = { ...out.meta, archiveDays: inWindow.length };
      const baseline = wantsGhostLine(config.comparison)
        ? comparisonBaseline(config.comparison, since, until, grain)
        : null;
      if (baseline) {
        const baseRows = levelPoints
          .filter((p) => {
            const timestamp = Date.parse(p.day);
            return Number.isFinite(timestamp) && timestamp >= baseline.from && timestamp <= baseline.to;
          })
          .map((p) => ({ day: p.day, subscribers: p.value }));
        const ghostSeries = bucketSubscriberLevels(baseRows, grain);
        if (ghostSeries.length >= 2 && ghostSeries.length === out.series.length) {
          out.ghost = ghostSeries.map((point) => point.value);
          out.ghostLabel = config.comparison ? COMPARISON_LABEL[config.comparison.mode] : undefined;
        } else {
          out.meta = { ...out.meta, comparisonNote: 'сравнение скрыто — не хватает архива' };
        }
      }
    } else {
      // Без архива уровень строить не из чего — прежняя карточка-число без подписи периода.
      out.meta = { ...out.meta, periodLabel: undefined };
    }
    out.valueRaw = count || inWindow[inWindow.length - 1]!.subscribers;
    out.value = fmt.num(out.valueRaw);
    return out;
  }

  if (metric.id === 'ig.erv') {
    const reach = igWindowValue(igSeriesPoints(ig.insights, ig.history, 'reach'), since, until).cur;
    const interactions = igWindowValue(
      igSeriesPoints(ig.insights, ig.history, 'total_interactions'),
      since,
      until,
    ).cur;
    if (reach <= 0) return { ...out, empty: true };
    const engagementRate = (interactions / reach) * 100;
    out.valueRaw = engagementRate;
    out.value = `${engagementRate.toFixed(2)}%`;
    return out;
  }

  const resolveBreakdown = BREAKDOWN_RESOLVERS[metric.id];
  if (!resolveBreakdown) return { ...out, empty: true };
  out.meta = { ...out.meta, periodLabel: undefined };
  const items = resolveBreakdown(ig);
  if (items.length === 0 || items.every((item) => item.value === 0)) return { ...out, empty: true };
  out.breakdown = items;
  return out;
};
