import { freshness, latestDataMs } from '@/lib/freshness';
import {
  DAY_MS,
  bucketKeyOf,
  bucketKeysInWindow,
  comparisonWindow,
} from '@/lib/metricSeries';
import type { SeriesGrain } from '@/lib/metricSeries';
import type { NormalizedPost } from '@/lib/posts';
import type { PostMetricField } from '@/lib/kpiDerive';
import type { ComparisonConfig, ComparisonMode, WidgetConfig, WidgetGrain } from '@/lib/widgetConfig';
import type { DataContext, WidgetMeta, WidgetSeriesPoint } from '@/lib/widgetResolver/types';

export const COMPARISON_LABEL: Record<ComparisonMode, string> = {
  none: '',
  previous_period: 'прошлый период',
  same_period_last_month: 'прошлый месяц',
  same_period_last_year: 'год назад',
  same_weekday: 'типичный день недели',
  moving_average: 'скользящее среднее',
  custom: 'выбранный период',
};

function shiftMonthsUTC(ms: number, months: number): number {
  const d = new Date(ms);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const maxDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, maxDay));
  return d.getTime();
}

export function comparisonBaseline(
  cmp: ComparisonConfig | undefined,
  winFrom: number | null,
  winTo: number,
  grain: SeriesGrain,
): { from: number; to: number } | null {
  if (!cmp || cmp.mode === 'none') return null;
  if (cmp.mode === 'custom') return cmp.from != null && cmp.to != null ? { from: cmp.from, to: cmp.to } : null;
  if (winFrom == null) return null;
  if (cmp.mode === 'previous_period') return comparisonWindow(winFrom, winTo, 'prev');
  if (cmp.mode === 'same_period_last_year') return comparisonWindow(winFrom, winTo, 'year');
  if (cmp.mode === 'same_period_last_month') {
    if (grain === 'month' || grain === 'quarter' || grain === 'year') {
      return { from: shiftMonthsUTC(winFrom, -1), to: shiftMonthsUTC(winTo, -1) };
    }
    const shift = 30 * DAY_MS;
    return { from: winFrom - shift, to: winTo - shift };
  }
  return null;
}

export function wantsGhostLine(cmp: ComparisonConfig | undefined): boolean {
  return (cmp?.display ?? 'ghost_line') !== 'delta';
}

export function effectiveGrain(grain: WidgetGrain | undefined): SeriesGrain {
  return grain === 'week' || grain === 'month' || grain === 'quarter' || grain === 'year' ? grain : 'day';
}

export function bucketPostField(
  posts: NormalizedPost[],
  field: PostMetricField,
  winFrom: number | null,
  winTo: number,
  grain: SeriesGrain,
): WidgetSeriesPoint[] {
  const by = new Map<string, number>();
  for (const post of posts) {
    if (!post.date) continue;
    const timestamp = Date.parse(post.date);
    if (!Number.isFinite(timestamp)) continue;
    const key = bucketKeyOf(timestamp, grain);
    by.set(key, (by.get(key) ?? 0) + Number(post[field] ?? 0));
  }
  const keys = winFrom != null ? bucketKeysInWindow(winFrom, winTo, grain) : [...by.keys()].sort();
  return keys.map((key) => ({ date: key, value: by.get(key) ?? 0 }));
}

export function bucketSubscriberLevels(
  rows: { day: string; subscribers?: number | null }[],
  grain: SeriesGrain,
): WidgetSeriesPoint[] {
  const by = new Map<string, number>();
  rows
    .filter((row) => row.subscribers != null)
    .sort((a, b) => a.day.localeCompare(b.day))
    .forEach((row) => {
      const timestamp = Date.parse(row.day);
      if (Number.isFinite(timestamp)) by.set(bucketKeyOf(timestamp, grain), Number(row.subscribers));
    });
  return [...by.keys()].sort().map((key) => ({ date: key, value: by.get(key)! }));
}

function localDay(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function commonMeta(config: WidgetConfig, ctx: DataContext, network: 'tg' | 'ig' | 'ms'): WidgetMeta {
  const meta: WidgetMeta = {
    network,
    periodLabel: ctx.range ? 'выбранный период' : ctx.days > 0 ? `за ${ctx.days} дн.` : 'за всё время',
  };
  if (config.source != null) {
    if (network === 'tg') {
      const channel = ctx.tg?.channels?.channels?.find((candidate) => candidate.id === ctx.tg?.channelId);
      if (channel) meta.sourceLabel = `@${channel.username || channel.title || channel.id}`;
    } else if (network === 'ms') {
      // Имя организации в ctx недоступно (summary его не несёт) — честная подпись источника-сети.
      meta.sourceLabel = 'МойСклад';
    } else {
      const username = ctx.ig?.profile?.username;
      if (username) meta.sourceLabel = `@${username}`;
    }
  }
  if (network === 'tg' && ctx.tg) {
    const timestamp = latestDataMs(ctx.tg.full?.posts ?? undefined, ctx.tg.history ?? undefined);
    const fresh = timestamp != null ? freshness(localDay(timestamp), ctx.now) : null;
    if (fresh) meta.fresh = fresh;
  } else if (network === 'ig' && ctx.ig?.history?.rows?.length) {
    let latest: string | null = null;
    for (const row of ctx.ig.history.rows) {
      if (row.day && (latest === null || row.day > latest)) latest = row.day;
    }
    const fresh = freshness(latest, ctx.now);
    if (fresh) meta.fresh = fresh;
  }
  return meta;
}
