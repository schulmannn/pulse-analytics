import { useMemo, useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useChannels, useHistory, useTgFull } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { usePeriod } from '@/lib/period';
import type { PeriodDays } from '@/lib/period';
import { deriveKpis, isDrillKey } from '@/lib/kpiDerive';
import type { DailySeries, DrillKey, PostMetricField } from '@/lib/kpiDerive';
import { METRIC_DEFS } from '@/lib/metricDefs';
import type { MetricDef } from '@/lib/metricDefs';
import { fmt } from '@/lib/format';
import { markdownToPlainText } from '@/lib/markdown';
import type { NormalizedPost } from '@/lib/posts';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ErrorState';
import { DeltaPill } from '@/components/DeltaPill';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { ChartExpandedContext } from '@/components/ExpandableChart';
import { Breakdown } from '@/components/Breakdown';
import { RankChart } from '@/components/RankChart';
import { PivotTable } from '@/components/PivotTable';
import { PostDetailModal } from '@/components/PostDetailModal';
import { ChartSection } from '@/components/instagram/shared';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';

const DAY_MS = 24 * 60 * 60 * 1000;

// ── View state (all in the URL so links restore the exact view, like steep) ──────────────
type ChartType = 'line' | 'bar' | 'rank' | 'pivot';
type Grain = 'day' | 'week' | 'month';
type CompareMode = 'off' | 'prev' | 'year';
type Dim = 'format' | 'weekday';

const GRAIN_WORD: Record<Grain, string> = { day: 'дням', week: 'неделям', month: 'месяцам' };
const GRAIN_LABEL: Record<Grain, string> = { day: 'День', week: 'Неделя', month: 'Месяц' };
const CMP_LABEL: Record<Exclude<CompareMode, 'off'>, string> = {
  prev: 'прошлый период',
  year: 'тот же период год назад',
};
const DIM_LABEL: Record<Dim, string> = { format: 'Формат', weekday: 'День недели' };
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

// Which NormalizedPost field a metric attributes to. null = no per-post attribution (subscribers).
const FIELD: Partial<Record<DrillKey, PostMetricField>> = {
  views: 'reach',
  avgReach: 'reach',
  reactions: 'likes',
  forwards: 'shares',
  er: 'eng',
};

const CONTRIB_LABEL: Partial<Record<DrillKey, string>> = {
  views: 'просмотрам',
  avgReach: 'охвату',
  reactions: 'реакциям',
  forwards: 'репостам',
  er: 'вовлечённости',
};

// Chart heading prefix. Ratio metrics (avgReach/ER) are derived from a sum, so the chart shows
// that underlying sum (reach / engagement), not the ratio itself — the heading says so.
const SERIES_PREFIX: Partial<Record<DrillKey, string>> = {
  subscribers: 'Подписчики по ',
  avgReach: 'Просмотры по ',
  er: 'Вовлечённость по ',
};

// What a per-post contribution is a share OF (ratio metrics: the underlying sum, not the ratio).
const SHARE_LABEL: Partial<Record<DrillKey, string>> = {
  avgReach: '% охвата',
  er: '% вовлечённости',
};

// Volume metrics start the y-axis at zero (bar-like honesty for sums); the subscriber count is a
// stock metric where the zoomed band is the story, so it keeps the fitted scale.
const ZERO_BASED: Record<DrillKey, boolean> = {
  views: true,
  avgReach: true,
  reactions: true,
  forwards: true,
  er: true,
  subscribers: false,
};

/** Post format for the breakdown/rank rows (same buckets as the Compare tab). */
function formatLabel(mediaType: string | null, albumSize: number): string {
  if (albumSize > 1) return 'Альбом';
  if (mediaType === 'photo') return 'Фото';
  if (mediaType === 'video') return 'Видео';
  if (mediaType === 'document') return 'Файл';
  return 'Текст';
}

/** Dimension bucket of a post (format / weekday) for rank, pivot and the breakdown list. */
function dimLabelOf(post: NormalizedPost, dim: Dim): string | null {
  if (dim === 'format') return formatLabel(post.mediaType, post.albumSize);
  if (!post.date) return null;
  const t = Date.parse(post.date);
  if (!Number.isFinite(t)) return null;
  return WEEKDAYS[(new Date(t).getUTCDay() + 6) % 7];
}

// ── Grain-aware time buckets (UTC, like every daily key in the app) ─────────────────────
function bucketKeyOf(t: number, grain: Grain): string {
  const d = new Date(t);
  if (grain === 'day') return d.toISOString().slice(0, 10);
  if (grain === 'week') {
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 7);
}

function bucketLabelOf(key: string, grain: Grain): string {
  if (grain === 'month') {
    return new Date(`${key}-01T00:00:00Z`).toLocaleDateString('ru-RU', { month: 'short', timeZone: 'UTC' });
  }
  return fmt.day(key);
}

/** All bucket keys covering [from..to], in order (day steps / Mondays / first-of-month). */
function bucketKeysInWindow(fromMs: number, toMs: number, grain: Grain): string[] {
  const keys: string[] = [];
  if (grain === 'month') {
    const d = new Date(fromMs);
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
    while (d.getTime() <= toMs) {
      keys.push(d.toISOString().slice(0, 7));
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
    return keys;
  }
  const step = grain === 'week' ? 7 * DAY_MS : DAY_MS;
  let t = grain === 'week' ? Date.parse(bucketKeyOf(fromMs, 'week')) : fromMs - (fromMs % DAY_MS);
  for (; t <= toMs; t += step) keys.push(bucketKeyOf(t, grain));
  return keys;
}

/** Zero-filled per-bucket sums of a post field over a window. */
function bucketedPostSeries(
  posts: NormalizedPost[],
  field: PostMetricField,
  fromMs: number | null,
  toMs: number,
  grain: Grain,
): DailySeries {
  const byBucket = new Map<string, number>();
  for (const post of posts) {
    if (!post.date) continue;
    const t = Date.parse(post.date);
    if (!Number.isFinite(t)) continue;
    const key = bucketKeyOf(t, grain);
    byBucket.set(key, (byBucket.get(key) ?? 0) + Number(post[field] ?? 0));
  }
  const keys =
    fromMs != null
      ? bucketKeysInWindow(fromMs, toMs, grain)
      : [...byBucket.keys()].sort(); // «Всё»: sparse, only buckets with data
  return {
    labels: keys.map((k) => bucketLabelOf(k, grain)),
    values: keys.map((k) => byBucket.get(k) ?? 0),
  };
}

/** Subscriber level per bucket (last archive value inside the bucket) — sparse, data-only. */
function bucketedSubsSeries(
  rows: { day: string; subscribers?: number | null }[],
  grain: Grain,
): DailySeries {
  const byBucket = new Map<string, number>();
  const sorted = rows
    .filter((r) => r.subscribers != null)
    .sort((a, b) => a.day.localeCompare(b.day));
  for (const row of sorted) {
    const t = Date.parse(row.day);
    if (!Number.isFinite(t)) continue;
    byBucket.set(bucketKeyOf(t, grain), Number(row.subscribers)); // later rows overwrite = last-of-bucket
  }
  const keys = [...byBucket.keys()].sort();
  return { labels: keys.map((k) => bucketLabelOf(k, grain)), values: keys.map((k) => byBucket.get(k)!) };
}

/**
 * Metric page — the steep-style metric explorer: headline reconciled with the Overview ledger
 * (shared deriveKpis), a large chart in four projections (line / bar / rank-by-dimension /
 * pivot dimension × time), an Explore rail (breakdown dimension, comparison baseline, the
 * plain-language About) and a bottom time bar (grain + window presets + ‹ › pager). Every
 * view knob lives in the URL, so a shared link restores the exact view.
 */
export function MetricPage() {
  const { key: rawKey } = useParams();
  const { days, setDays, range, setRange, inRange } = usePeriod();
  const { data, isPending, isError, error } = useTgFull(days, { windowPair: true });
  const { data: history } = useHistory(730);
  const { channelId } = useSelectedChannel();
  const { data: channelsData } = useChannels();
  const [openPost, setOpenPost] = useState<NormalizedPost | null>(null);

  const [params, setParams] = useSearchParams();
  const setParam = (key: string, value: string | null) => {
    setParams(
      (prev) => {
        const merged = new URLSearchParams(prev);
        if (value == null) merged.delete(key);
        else merged.set(key, value);
        return merged;
      },
      { replace: true },
    );
  };
  const rawChart = params.get('chart');
  const grainParam = params.get('grain');
  const grain: Grain = grainParam === 'week' || grainParam === 'month' ? grainParam : 'day';
  const cmpParam = params.get('cmp');
  const cmp: CompareMode = cmpParam === 'off' ? 'off' : cmpParam === 'year' ? 'year' : 'prev';
  const dim: Dim = params.get('dim') === 'weekday' ? 'weekday' : 'format';

  const derived = useMemo(
    () => deriveKpis(data, history, channelsData, channelId, days, range, inRange),
    [data, history, channelsData, channelId, days, range, inRange],
  );

  if (!isDrillKey(rawKey)) return <Navigate to="/" replace />;
  const metricKey = rawKey;
  const field = FIELD[metricKey];
  const chartType: ChartType =
    rawChart === 'bar' || (field && (rawChart === 'rank' || rawChart === 'pivot')) ? (rawChart as ChartType) : 'line';

  if (isPending) return <MetricSkeleton />;
  if (isError) {
    return <ErrorState title="Не удалось загрузить метрику" reason={error instanceof Error ? error.message : 'ошибка'} />;
  }

  // Widened to MetricDef: the `satisfies` map narrows each entry, hiding optional fields.
  const def: MetricDef = METRIC_DEFS[metricKey];
  const meta = derived.drillMeta[metricKey];
  const { normPosts, normPostsAll, subsSpark, historyRows, members, periodLabel } = derived;

  // ── Windows: active + comparison baseline ─────────────────────────────────────────────
  const winTo = range ? range.to : Date.now();
  const winFrom = range ? range.from : days > 0 ? winTo - (days - 1) * DAY_MS : null;
  const spanMs = winFrom != null ? winTo - winFrom : null;
  const baseWin =
    cmp === 'off' || winFrom == null || spanMs == null
      ? null
      : cmp === 'prev'
        ? { from: winFrom - spanMs - DAY_MS, to: winFrom - 1 }
        : { from: winFrom - 365 * DAY_MS, to: winTo - 365 * DAY_MS };
  const cmpLabel = cmp === 'off' ? null : CMP_LABEL[cmp];

  // Grain availability follows the window size (a 7-day window has no meaningful months).
  const winDays = spanMs != null ? Math.round(spanMs / DAY_MS) + 1 : Infinity;
  const grainAllowed: Record<Grain, boolean> = {
    day: true,
    week: winDays >= 14,
    month: winDays >= 60,
  };
  const effGrain: Grain = grainAllowed[grain] ? grain : 'day';

  // ── Series (line/bar) + baseline ghost ────────────────────────────────────────────────
  // Baseline posts: the full normalized set filtered to the baseline window (plain compute —
  // ≤100 posts, and hooks can't live below the early returns above).
  const postsInBase = baseWin
    ? normPostsAll.filter((post) => {
        if (!post.date) return false;
        const t = Date.parse(post.date);
        return Number.isFinite(t) && t >= baseWin.from && t <= baseWin.to;
      })
    : [];

  let series: DailySeries;
  let ghost: number[] | undefined;
  if (metricKey === 'subscribers') {
    const inWin = historyRows.filter((r) => inRange(r.day));
    series = effGrain === 'day' ? subsSpark : bucketedSubsSeries(inWin, effGrain);
    if (baseWin) {
      const baseRows = historyRows.filter((r) => {
        const t = Date.parse(r.day);
        return Number.isFinite(t) && t >= baseWin.from && t <= baseWin.to;
      });
      const base =
        effGrain === 'day'
          ? bucketedSubsSeries(baseRows, 'day')
          : bucketedSubsSeries(baseRows, effGrain);
      if (base.values.length === series.values.length && base.values.length >= 2) ghost = base.values;
    }
  } else if (field) {
    series =
      winFrom != null && winDays <= 400
        ? bucketedPostSeries(normPosts, field, winFrom, winTo, effGrain)
        : bucketedPostSeries(normPosts, field, null, winTo, effGrain);
    if (baseWin) {
      const base = bucketedPostSeries(postsInBase, field, baseWin.from, baseWin.to, effGrain);
      if (base.values.length === series.values.length && base.values.some((v) => v > 0)) ghost = base.values;
    }
  } else {
    series = { labels: [], values: [] };
  }

  const valueFmt = metricKey === 'subscribers' ? fmt.num : fmt.short;
  const titles = series.values.map((v, i) => `${series.labels[i]}: ${valueFmt(v)}`);

  // ── Rank + pivot data (dimension-aggregated) ──────────────────────────────────────────
  const sumByDim = (posts: NormalizedPost[]): Map<string, number> => {
    const acc = new Map<string, number>();
    if (!field) return acc;
    for (const post of posts) {
      const label = dimLabelOf(post, dim);
      if (!label) continue;
      acc.set(label, (acc.get(label) ?? 0) + Number(post[field] ?? 0));
    }
    return acc;
  };
  const curByDim = field ? sumByDim(normPosts) : new Map<string, number>();
  const baseByDim = field && baseWin ? sumByDim(postsInBase) : null;
  const rankItems = [...curByDim.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([label, value]) => ({
      label,
      value,
      compare: baseByDim?.size ? baseByDim.get(label) ?? 0 : null,
    }));

  const pivotKeys = winFrom != null ? bucketKeysInWindow(winFrom, winTo, effGrain) : [];
  const pivot = (() => {
    if (!field || pivotKeys.length === 0) return { columns: [], rows: [] };
    const matrix = new Map<string, Map<string, number>>();
    for (const post of normPosts) {
      const label = dimLabelOf(post, dim);
      if (!label || !post.date) continue;
      const t = Date.parse(post.date);
      if (!Number.isFinite(t)) continue;
      const col = bucketKeyOf(t, effGrain);
      const row = matrix.get(label) ?? new Map<string, number>();
      row.set(col, (row.get(col) ?? 0) + Number(post[field] ?? 0));
      matrix.set(label, row);
    }
    const rowLabels =
      dim === 'weekday'
        ? WEEKDAYS.filter((w) => matrix.has(w))
        : [...matrix.keys()].sort(
            (a, b) =>
              [...(matrix.get(b)?.values() ?? [])].reduce((s, v) => s + v, 0)
              - [...(matrix.get(a)?.values() ?? [])].reduce((s, v) => s + v, 0),
          );
    return {
      columns: pivotKeys.map((k) => ({ key: k, label: bucketLabelOf(k, effGrain) })),
      rows: rowLabels.map((label) => ({
        label,
        values: pivotKeys.map((k) => matrix.get(label)?.get(k) ?? null),
      })),
    };
  })();

  // ── Breakdown list (rail) — follows the dimension ─────────────────────────────────────
  const breakdownItems = [...curByDim.entries()]
    .filter(([, value]) => value > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([label, value]) => ({ label, value, display: fmt.short(value) }));

  // ── Contributors + reconciliation ─────────────────────────────────────────────────────
  const contributors = field
    ? normPosts
        .filter((p) => Number(p[field] ?? 0) > 0)
        .sort((a, b) => Number(b[field] ?? 0) - Number(a[field] ?? 0))
        .slice(0, 8)
    : [];
  const fieldSumAll = field ? normPosts.reduce((s, p) => s + Number(p[field] ?? 0), 0) : 0;
  const contribTotal = field ? contributors.reduce((s, p) => s + Number(p[field] ?? 0), 0) : 0;
  let reconcile = '';
  if (field) {
    if (metricKey === 'er' && members > 0) {
      reconcile = `ER = ${fmt.short(fieldSumAll)} вовлечений ÷ ${fmt.num(members)} подписчиков × 100% = ${meta.total}`;
    } else if (metricKey === 'avgReach' && normPosts.length > 0) {
      reconcile = `Средний охват = ${fmt.short(fieldSumAll)} просмотров ÷ ${normPosts.length} постов = ${meta.total}`;
    } else if (contributors.length > 0 && contribTotal > 0 && fieldSumAll > 0) {
      reconcile = `Эти ${contributors.length} постов дали ${Math.round((contribTotal / fieldSumAll) * 100)}% от периода.`;
    }
  }

  // ── «Сравнение» numbers vs the chosen baseline ────────────────────────────────────────
  const compare = (() => {
    if (!baseWin || cmp === 'off') return null;
    if (field) {
      if (postsInBase.length === 0) return null;
      const cur = fieldSumAll;
      const base = postsInBase.reduce((s, p) => s + Number(p[field] ?? 0), 0);
      if (metricKey === 'er' && members > 0) {
        return { current: `${((cur / members) * 100).toFixed(2)}%`, previous: `${((base / members) * 100).toFixed(2)}%`, cur, base };
      }
      if (metricKey === 'avgReach') {
        const curAvg = normPosts.length ? cur / normPosts.length : 0;
        const baseAvg = base / postsInBase.length;
        return { current: fmt.short(curAvg), previous: fmt.short(baseAvg), cur: curAvg, base: baseAvg };
      }
      return { current: fmt.short(cur), previous: fmt.short(base), cur, base };
    }
    // Subscribers: change within each window, from the daily archive.
    const change = (rows: typeof historyRows) => {
      const subs = rows
        .filter((r) => r.subscribers != null)
        .sort((a, b) => a.day.localeCompare(b.day))
        .map((r) => Number(r.subscribers));
      return subs.length >= 2 ? subs[subs.length - 1] - subs[0] : null;
    };
    const curChange = change(historyRows.filter((r) => inRange(r.day)));
    const baseChange = change(
      historyRows.filter((r) => {
        const t = Date.parse(r.day);
        return Number.isFinite(t) && t >= baseWin.from && t <= baseWin.to;
      }),
    );
    if (curChange == null || baseChange == null) return null;
    const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt.num(Math.abs(n))}`;
    return { current: signed(curChange), previous: signed(baseChange), cur: curChange, base: baseChange };
  })();
  const compareDelta =
    compare && compare.base !== 0 && Number.isFinite(compare.base)
      ? ((compare.cur - compare.base) / Math.abs(compare.base)) * 100
      : null;

  // ── Bottom time bar: presets + pager ──────────────────────────────────────────────────
  const shiftWindow = (dir: -1 | 1) => {
    if (winFrom == null || spanMs == null) return;
    const step = spanMs + DAY_MS;
    if (dir === 1) {
      if (!range) return; // already the latest rolling window
      const nextTo = winTo + step;
      // A day of tolerance: a window that would touch today IS the rolling window — snap to
      // the live preset instead of pinning an equivalent fixed range.
      if (nextTo >= Date.now() - DAY_MS) {
        setRange(null);
        return;
      }
      setRange({ from: winFrom + step, to: nextTo });
    } else {
      setRange({ from: winFrom - step, to: winTo - step });
    }
  };

  const chartTitle =
    chartType === 'rank'
      ? `Рейтинг · ${DIM_LABEL[dim].toLowerCase()}`
      : chartType === 'pivot'
        ? `Сводная · ${DIM_LABEL[dim].toLowerCase()} × по ${GRAIN_WORD[effGrain]}`
        : `${SERIES_PREFIX[metricKey] ?? 'По '}${GRAIN_WORD[effGrain]}`;

  const chartTypes: ChartType[] = field ? ['line', 'bar', 'rank', 'pivot'] : ['line', 'bar'];

  return (
    <div className="space-y-8">
      {/* Breadcrumb back to the ledger the metric was opened from. */}
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
        <span aria-hidden="true">←</span> Обзор
      </Link>

      {/* Headline — same value/Δ/caption as the Overview ledger cell (shared derive). */}
      <div>
        <div className="text-xs tracking-wide text-muted-foreground">
          {def.term} · {periodLabel}
        </div>
        <div className="mt-2 flex items-baseline gap-2.5">
          <span className="text-hero font-medium leading-none tabular-nums tracking-tight">{meta.total}</span>
          <DeltaPill delta={meta.trend} />
        </div>
        {meta.caption ? <div className="mt-2 text-xs text-muted-foreground">{meta.caption}</div> : null}
      </div>

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_300px]">
        {/* Main column — the big chart in four projections + contributing posts. */}
        <div className="min-w-0 space-y-8">
          <ChartWidget
            id={`metric-${metricKey}`}
            title={chartTitle}
            defaultSize="full"
            action={
              <div role="group" aria-label="Тип графика" className="flex shrink-0 overflow-hidden rounded border border-border">
                {chartTypes.map((kind) => (
                  <ChartTypeButton
                    key={kind}
                    kind={kind}
                    active={chartType === kind}
                    onSelect={(next) => setParam('chart', next === 'line' ? null : next)}
                  />
                ))}
              </div>
            }
          >
            {chartType === 'line' && (
              /* Expanded context: the metric page's big chart always renders the full y-axis
                 (dashboards are axis-free; the explorer is where the scale lives). */
              <ChartExpandedContext.Provider value={true}>
                <LineChart
                  values={series.values}
                  labels={series.labels}
                  titles={titles}
                  height={280}
                  markExtremes
                  markAnomalies={effGrain === 'day' && (metricKey === 'views' || metricKey === 'subscribers')}
                  showPoints={series.values.length > 1 && series.values.length <= 45}
                  ghost={ghost}
                  yMin={ZERO_BASED[metricKey] && series.values.length > 1 ? 0 : undefined}
                />
                {ghost && cmpLabel ? (
                  <p className="text-2xs text-muted-foreground">Пунктир — {cmpLabel}.</p>
                ) : null}
              </ChartExpandedContext.Provider>
            )}
            {chartType === 'bar' && (
              /* Expanded context switches BarChart into its rich mode (y ticks + value labels). */
              <ChartExpandedContext.Provider value={true}>
                <BarChart values={series.values} labels={series.labels} titles={titles} height={280} />
              </ChartExpandedContext.Provider>
            )}
            {chartType === 'rank' && (
              <RankChart items={rankItems} valueFmt={fmt.short} compareLabel={cmpLabel} />
            )}
            {chartType === 'pivot' && (
              <PivotTable columns={pivot.columns} rows={pivot.rows} valueFmt={fmt.short} />
            )}
          </ChartWidget>

          {field && (
            <ChartSection title={`Топ постов по ${CONTRIB_LABEL[metricKey] ?? 'метрике'}`}>
              {contributors.length > 0 ? (
                <ul>
                  {contributors.map((post, i) => {
                    const value = Number(post[field] ?? 0);
                    const share = fieldSumAll > 0 ? Math.round((value / fieldSumAll) * 100) : 0;
                    const text = post.caption ? markdownToPlainText(post.caption) : 'Без подписи';
                    return (
                      <li key={post.id ?? i} className="border-t border-border first:border-t-0">
                        <button
                          type="button"
                          onClick={() => setOpenPost(post)}
                          className="flex w-full items-center gap-3 py-2.5 text-left transition-colors hover:bg-hover-row"
                        >
                          <span className="w-5 shrink-0 text-center text-xs font-medium tabular-nums text-muted-foreground">
                            {i + 1}
                          </span>
                          {post.thumb ? (
                            <img
                              src={`${post.thumb}?size=sm`}
                              alt=""
                              referrerPolicy="no-referrer"
                              className="h-9 w-9 shrink-0 rounded object-cover"
                            />
                          ) : (
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-muted text-2xs text-muted-foreground">
                              текст
                            </span>
                          )}
                          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{text}</span>
                          <span className="shrink-0 text-right">
                            <span className="block text-sm font-medium tabular-nums">{fmt.short(value)}</span>
                            {share > 0 && (
                              <span className="block text-2xs text-muted-foreground">
                                {share}
                                {SHARE_LABEL[metricKey] ?? '% периода'}
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="py-6 text-center text-sm text-muted-foreground">Недостаточно данных за период.</div>
              )}
              {reconcile && <p className="text-xs text-muted-foreground">{reconcile}</p>}
            </ChartSection>
          )}
        </div>

        {/* Explore rail — breakdown dimension, comparison baseline, the About block. */}
        <aside className="space-y-8">
          {field && (
            <ChartSection title="Разбивка">
              <SegSelect
                ariaLabel="Измерение разбивки"
                value={dim}
                onChange={(next) => setParam('dim', next === 'format' ? null : next)}
                options={[
                  { value: 'format' as Dim, label: 'Формат' },
                  { value: 'weekday' as Dim, label: 'День недели' },
                ]}
              />
              <Breakdown items={breakdownItems} />
            </ChartSection>
          )}

          <ChartSection title="Сравнение">
            {winFrom == null ? (
              <p className="text-xs text-muted-foreground">Для окна «Всё» прошлого периода не существует.</p>
            ) : (
              <>
                <SegSelect
                  ariaLabel="База сравнения"
                  value={cmp}
                  onChange={(next) => setParam('cmp', next === 'prev' ? null : next)}
                  options={[
                    { value: 'off' as CompareMode, label: 'Выкл' },
                    { value: 'prev' as CompareMode, label: 'Пред. период' },
                    { value: 'year' as CompareMode, label: 'Год назад' },
                  ]}
                />
                {cmp === 'off' ? (
                  <p className="text-xs text-muted-foreground">Выберите базу — пунктир на линии, пары в рейтинге и Δ появятся автоматически.</p>
                ) : compare ? (
                  <div className="space-y-2 text-sm">
                    <CompareRow label="Текущий период" value={compare.current} strong />
                    <CompareRow label={cmpLabel ?? ''} value={compare.previous} />
                    {compareDelta != null && (
                      <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2">
                        <span className="text-xs text-muted-foreground">Изменение</span>
                        <span className={`text-xs font-medium tabular-nums ${compareDelta >= 0 ? 'text-verdant' : 'text-ember'}`}>
                          {compareDelta >= 0 ? '▲' : '▼'}
                          {Math.abs(compareDelta).toFixed(1)}%
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    В выборке нет данных за {cmpLabel} — сравнить не с чем.
                  </p>
                )}
              </>
            )}
          </ChartSection>

          <ChartSection title="О метрике">
            <dl className="space-y-3 text-sm">
              {def.formula && <AboutRow label="Как считается" text={def.formula} />}
              {def.included && <AboutRow label="Что учитывается" text={def.included} />}
              {def.source && <AboutRow label="Источник" text={def.source} />}
            </dl>
          </ChartSection>

          <Link
            to="/analytics"
            className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary/80"
          >
            Открыть аналитику <span aria-hidden="true">→</span>
          </Link>
        </aside>
      </div>

      {/* Bottom time bar (steep): grain on the left, window presets + pager on the right. */}
      <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background/95 px-3 py-2 backdrop-blur print:hidden">
        <div role="group" aria-label="Гранулярность" className="flex overflow-hidden rounded border border-border">
          {(['day', 'week', 'month'] as Grain[]).map((g) => (
            <button
              key={g}
              type="button"
              disabled={!grainAllowed[g]}
              aria-pressed={effGrain === g}
              onClick={() => setParam('grain', g === 'day' ? null : g)}
              className={`px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                effGrain === g ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
              } border-r border-border last:border-r-0`}
            >
              {GRAIN_LABEL[g]}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {(
          [
            { days: 7 as PeriodDays, label: '7д' },
            { days: 30 as PeriodDays, label: '30д' },
            { days: 90 as PeriodDays, label: '90д' },
            { days: 0 as PeriodDays, label: 'Всё' },
          ]
        ).map((chip) => (
          <button
            key={chip.days}
            type="button"
            onClick={() => setDays(chip.days)}
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
              !range && days === chip.days
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            {chip.label}
          </button>
        ))}
        {range && (
          <button
            type="button"
            onClick={() => setRange(null)}
            title="Сбросить произвольный период"
            className="rounded-full border border-primary/40 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary"
          >
            {fmt.day(range.from)} – {fmt.day(range.to)} ×
          </button>
        )}
        <div className="flex items-center">
          <button
            type="button"
            onClick={() => shiftWindow(-1)}
            disabled={winFrom == null}
            aria-label="Предыдущее окно"
            className="rounded px-1.5 py-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => shiftWindow(1)}
            disabled={!range}
            aria-label="Следующее окно"
            className="rounded px-1.5 py-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            ›
          </button>
        </div>
      </div>

      {openPost && (
        <PostDetailModal
          post={openPost}
          rank={contributors.indexOf(openPost) + 1}
          reason={null}
          onClose={() => setOpenPost(null)}
        />
      )}
    </div>
  );
}

/** Bounded segmented control for the rail selects (dimension / comparison baseline). */
function SegSelect<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (next: T) => void;
  options: { value: T; label: string }[];
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="mb-3 flex overflow-hidden rounded border border-border">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={`flex-1 border-r border-border px-2 py-1 text-xs font-medium transition-colors last:border-r-0 ${
            value === opt.value ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** One cell of the chart-type switcher (steep's Explore icons, bounded segment). */
function ChartTypeButton({
  kind,
  active,
  onSelect,
}: {
  kind: 'line' | 'bar' | 'rank' | 'pivot';
  active: boolean;
  onSelect: (k: 'line' | 'bar' | 'rank' | 'pivot') => void;
}) {
  const LABELS = { line: 'Линия', bar: 'Столбцы', rank: 'Рейтинг', pivot: 'Сводная' } as const;
  const label = LABELS[kind];
  return (
    <button
      type="button"
      aria-pressed={active}
      title={label}
      aria-label={`Тип графика: ${label}`}
      onClick={() => onSelect(kind)}
      className={`flex h-7 w-8 items-center justify-center border-r border-border transition-colors last:border-r-0 ${
        active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
      }`}
    >
      {kind === 'line' && (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5" aria-hidden="true">
          <path d="M1.5 11.5 5.5 7l3 2.5 5.5-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {kind === 'bar' && (
        <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
          <rect x="2" y="8" width="3" height="6" rx="0.5" />
          <rect x="6.5" y="4" width="3" height="10" rx="0.5" />
          <rect x="11" y="6" width="3" height="8" rx="0.5" />
        </svg>
      )}
      {kind === 'rank' && (
        <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
          <rect x="2" y="3" width="12" height="2.5" rx="0.5" />
          <rect x="2" y="7" width="8" height="2.5" rx="0.5" />
          <rect x="2" y="11" width="5" height="2.5" rx="0.5" />
        </svg>
      )}
      {kind === 'pivot' && (
        <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
          <rect x="2" y="2" width="5.5" height="5.5" rx="0.5" />
          <rect x="8.5" y="2" width="5.5" height="5.5" rx="0.5" />
          <rect x="2" y="8.5" width="5.5" height="5.5" rx="0.5" />
          <rect x="8.5" y="8.5" width="5.5" height="5.5" rx="0.5" />
        </svg>
      )}
    </button>
  );
}

function CompareRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2 first:border-t-0 first:pt-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={strong ? 'font-medium tabular-nums text-foreground' : 'tabular-nums text-ink2'}>{value}</span>
    </div>
  );
}

function AboutRow({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <dt className="text-2xs tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm leading-relaxed text-foreground">{text}</dd>
    </div>
  );
}

function MetricSkeleton() {
  // Mirrors the real layout (breadcrumb + hero + chart + rail) — no card/ledger swap on load.
  return (
    <div className="space-y-8">
      <Skeleton className="h-3 w-16" />
      <div>
        <Skeleton className="h-3 w-40" />
        <Skeleton className="mt-2 h-11 w-36" />
      </div>
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_300px]">
        <Skeleton className="h-[280px] w-full" />
        <div className="space-y-4">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      </div>
    </div>
  );
}
