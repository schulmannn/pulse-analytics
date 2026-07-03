// Pure Instagram aggregators for the metric resolver (S11) — the IG counterpart of tgAggregations.
// Turns the raw IG payloads (insights time-series, demographics breakdowns, online_followers) into
// the series + breakdown shapes the resolver assembles into a WidgetResult. Reuses the established
// pure IG math (lib/igMetrics: metricSeries / windowPair / tvBreakdown / aggregateOnline + the label
// maps) and the shared bucketing (lib/metricSeries), so the numbers match the existing IG panels.
//
// No React, no fetching — the window bounds (since/until) and grain are passed in.

import type { IgBreakdowns, IgHistoryData, IgHistoryRow, IgInsights, IgOnline } from '@/api/schemas';
import { fmt } from '@/lib/format';
import { pctDelta, type MetricDelta } from '@/lib/delta';
import { bucketKeyOf, bucketKeysInWindow, type SeriesGrain } from '@/lib/metricSeries';
import {
  AGE_ORDER,
  CHART_CYCLE,
  GENDER_LABEL,
  MEDIA_PRODUCT_CHART,
  MEDIA_PRODUCT_LABEL,
  aggregateOnline,
  cityName,
  countryName,
  metricSeries,
  tvBreakdown,
  windowPair,
  type Point,
} from '@/lib/igMetrics';
import type { BreakdownItem } from '@/lib/tgAggregations';

export interface SeriesPoint {
  date: string;
  value: number;
}

/** Persisted ig_daily rows → {day,value}[] for one column (port of useIgData.histSeries). */
function histSeries(rows: IgHistoryRow[] | undefined, col: keyof IgHistoryRow): Point[] {
  return (rows ?? [])
    .filter((r) => r.day && r[col] != null)
    .map((r) => ({ day: r.day, value: Number(r[col]) }));
}

/** Prefer whichever series carries MORE real dated points (DB-first: the cron accumulates a longer
 *  ig_daily series than the live API window; on day 1 the live series wins). Port of useIgData. */
function longerSeries(live: Point[], persisted: Point[]): Point[] {
  const dated = (s: Point[]) => s.filter((p) => p.day !== 'total' && Number.isFinite(Date.parse(p.day))).length;
  return dated(persisted) > dated(live) ? persisted : live;
}

/** The daily Point[] for a named IG insight series, lengthened by the persisted history for the two
 *  DB-backed columns (reach, follower_count) exactly as the IG panels do. */
export function igSeriesPoints(ins: IgInsights | undefined, history: IgHistoryData | undefined, name: string): Point[] {
  const live = metricSeries(ins, name);
  if (name === 'reach') return longerSeries(live, histSeries(history?.rows, 'reach'));
  if (name === 'follower_count') return longerSeries(live, histSeries(history?.rows, 'followers'));
  return live;
}

/** Net daily follower movement = gross follows − gross unfollows, aligned by day. */
export function igNetFollowerPoints(ins: IgInsights | undefined): Point[] {
  const byDay = new Map<string, number>();
  for (const p of metricSeries(ins, 'follows')) byDay.set(p.day, (byDay.get(p.day) ?? 0) + p.value);
  for (const p of metricSeries(ins, 'unfollows')) byDay.set(p.day, (byDay.get(p.day) ?? 0) - p.value);
  return [...byDay.entries()].map(([day, value]) => ({ day, value }));
}

/** Bucket a daily Point[] over [since..until] by grain — flow (SUM per bucket), like the TG flows. */
export function bucketIgSeries(points: Point[], since: number, until: number, grain: SeriesGrain): SeriesPoint[] {
  const by = new Map<string, number>();
  for (const p of points) {
    const t = Date.parse(p.day);
    if (!Number.isFinite(t) || t < since || t > until) continue;
    by.set(bucketKeyOf(t, grain), (by.get(bucketKeyOf(t, grain)) ?? 0) + p.value);
  }
  return bucketKeysInWindow(since, until, grain).map((k) => ({ date: k, value: by.get(k) ?? 0 }));
}

/** Current-window sum + whether the window HAS current data + a delta (windowPair over the points).
 *  `hasCur` is the honest «is there data?» signal — a genuine net-zero window (follows==unfollows)
 *  still has hasCur=true, so callers can distinguish real zero from no-data (matches the IG panels). */
export function igWindowValue(
  points: Point[],
  since: number,
  until: number,
): { cur: number; hasCur: boolean; delta: MetricDelta | null } {
  const pair = windowPair(points, since, until);
  return { cur: pair.cur, hasCur: pair.hasCur, delta: pair.hasCur && pair.hasPrev ? pctDelta(pair.cur, pair.prev) : null };
}

// ── Breakdowns (demographics / formats / hours) ───────────────────────────────────────────────
export function igFormatsBreakdown(bd: IgBreakdowns | undefined): BreakdownItem[] {
  // color is keyed off the RAW media_product_type (before the label remap) — the format-stable hue
  // MEDIA_PRODUCT_CHART, so the builder's format widget matches the IG dashboard's colours.
  return tvBreakdown(bd?.data, 'total_interactions', 'media_product_type')
    .map((i) => ({
      label: MEDIA_PRODUCT_LABEL[i.label] ?? i.label,
      value: i.value,
      display: fmt.short(i.value),
      color: MEDIA_PRODUCT_CHART[i.label],
    }))
    .filter((i) => i.value > 0)
    .sort((a, b) => b.value - a.value);
}

export function igAgeBreakdown(bd: IgBreakdowns | undefined): BreakdownItem[] {
  const raw = tvBreakdown(bd?.data, 'follower_demographics', 'age');
  // AGE_ORDER keeps the histogram buckets in chronological order (13-17 … 65+), not by value.
  return AGE_ORDER.map((bucket) => raw.find((a) => a.label === bucket))
    .filter((a): a is { label: string; value: number } => !!a)
    .map((a) => ({ label: a.label, value: a.value, display: fmt.short(a.value) }))
    .filter((i) => i.value > 0);
}

export function igGenderBreakdown(bd: IgBreakdowns | undefined): BreakdownItem[] {
  return tvBreakdown(bd?.data, 'follower_demographics', 'gender')
    .sort((a, b) => b.value - a.value)
    .map((g, i) => ({
      label: GENDER_LABEL[g.label] ?? g.label,
      value: g.value,
      display: fmt.short(g.value),
      color: CHART_CYCLE[i % CHART_CYCLE.length],
    }))
    .filter((i) => i.value > 0);
}

export function igCountriesBreakdown(bd: IgBreakdowns | undefined): BreakdownItem[] {
  return tvBreakdown(bd?.data, 'follower_demographics', 'country')
    .sort((a, b) => b.value - a.value)
    .slice(0, 8)
    .map((c) => ({ label: countryName(c.label), value: c.value, display: fmt.short(c.value) }))
    .filter((i) => i.value > 0);
}

export function igCitiesBreakdown(bd: IgBreakdowns | undefined): BreakdownItem[] {
  return tvBreakdown(bd?.data, 'follower_demographics', 'city')
    .sort((a, b) => b.value - a.value)
    .slice(0, 8)
    .map((c) => ({ label: cityName(c.label), value: c.value, display: fmt.short(c.value) }))
    .filter((i) => i.value > 0);
}

/** Followers-online by hour of day — the weekday×hour grid summed per hour. Empty when the metric
 *  returned no activity (the new API often does), so the resolver can show an honest empty state. */
export function igHoursBreakdown(online: IgOnline | undefined): BreakdownItem[] {
  const agg = aggregateOnline(online);
  if (!agg.hasSignal) return [];
  const hours = Array<number>(24).fill(0);
  agg.grid.forEach((row) => row.forEach((v, h) => (hours[h] += v)));
  return hours.map((v, h) => ({ label: `${h}:00`, value: Math.round(v), display: fmt.num(Math.round(v)) }));
}
