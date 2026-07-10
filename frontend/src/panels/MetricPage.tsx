import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useChannels, useHistory, useTgFull } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { usePeriod } from '@/lib/period';
import type { PeriodDays } from '@/lib/period';
import { deriveKpis, isDrillKey } from '@/lib/kpiDerive';
import type { DailySeries, DrillKey, PostMetricField } from '@/lib/kpiDerive';
import { METRIC_DEFS } from '@/lib/metricDefs';
import type { MetricDef } from '@/lib/metricDefs';
import { fmt, pluralRu } from '@/lib/format';
import { markdownToPlainText } from '@/lib/markdown';
import { PinnedDayPanel } from '@/components/PinnedDayPanel';
import type { NormalizedPost } from '@/lib/posts';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ErrorState';
import { DeltaPill } from '@/components/DeltaPill';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { DivergingBars } from '@/components/DivergingBars';
import { ChartExpandedContext } from '@/components/ExpandableChart';
import { Breakdown } from '@/components/Breakdown';
import { RankChart } from '@/components/RankChart';
import { PivotTable } from '@/components/PivotTable';
import { PostDetailModal } from '@/components/PostDetailModal';
import { ChartSection } from '@/components/instagram/shared';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { DateRangePicker } from '@/components/DateRangePicker';
import { DAY_MS, alignGhost, baselineCoveredByPosts, bucketKeyOf, bucketKeysInWindow, comparisonWindow } from '@/lib/metricSeries';
import type { Grain } from '@/lib/metricSeries';

// ── View state (all in the URL so links restore the exact view, like steep) ──────────────
type ChartType = 'line' | 'bar' | 'rank' | 'pivot';
type CompareMode = 'off' | 'prev' | 'year';
type Dim = 'format' | 'weekday';

const GRAIN_WORD: Record<Grain, string> = { day: 'дням', week: 'неделям', month: 'месяцам' };
const GRAIN_LABEL: Record<Grain, string> = { day: 'День', week: 'Неделя', month: 'Месяц' };
const CMP_LABEL: Record<Exclude<CompareMode, 'off'>, string> = {
  prev: 'прошлый период',
  year: 'тот же период год назад',
};
// Легенда/тултип графика — короткий капитализированный чип (смешанный регистр «Текущий период ·
// прошлый период» в одной легенде — проход №3); CMP_LABEL выше остаётся строчным для ПРОЗЫ rail.
const CMP_CHIP: Record<Exclude<CompareMode, 'off'>, string> = {
  prev: 'Пред. период',
  year: 'Год назад',
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

// ── Explorer chart height ────────────────────────────────────────────────────────────────────
// The big chart owns the viewport (steep) instead of a fixed 280px strip: everything around it
// (topbar + headline + card chrome + sticky toolbar + gaps) is roughly constant chrome, so the
// chart takes what's left, clamped to sane bounds. Resize-aware; SSR-safe fallback.
const CHART_CHROME = 430;
const clampChartH = (viewportH: number) => Math.max(340, Math.min(620, viewportH - CHART_CHROME));
export function useExplorerChartHeight(): number {
  const [h, setH] = useState(() => clampChartH(typeof window !== 'undefined' ? window.innerHeight : 900));
  useEffect(() => {
    const onResize = () => setH(clampChartH(window.innerHeight));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return h;
}

/** Local calendar-day key of an instant (parseDayKey semantics — the viewer's local date). */
function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Grain-aware time buckets (bucketKeyOf / bucketKeysInWindow now live in lib/metricSeries) ─
function bucketLabelOf(key: string, grain: Grain): string {
  if (grain === 'month') {
    return new Date(`${key}-01T00:00:00Z`).toLocaleDateString('ru-RU', { month: 'short', timeZone: 'UTC' });
  }
  return fmt.day(key);
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

/** Channel-wide daily-FLOW metric (views) summed per bucket from the archive — matches the Overview
 *  «Просмотры» headline (deriveKpis channelViews). Sum semantics, unlike the subscriber LEVEL series. */
function bucketedHistoryFlow(
  rows: { day: string; views?: number | null }[],
  fromMs: number | null,
  toMs: number,
  grain: Grain,
): DailySeries {
  const byBucket = new Map<string, number>();
  for (const row of rows) {
    if (row.views == null) continue;
    const t = Date.parse(row.day);
    if (!Number.isFinite(t)) continue;
    const key = bucketKeyOf(t, grain);
    byBucket.set(key, (byBucket.get(key) ?? 0) + Number(row.views));
  }
  const keys = fromMs != null ? bucketKeysInWindow(fromMs, toMs, grain) : [...byBucket.keys()].sort();
  return { labels: keys.map((k) => bucketLabelOf(k, grain)), values: keys.map((k) => byBucket.get(k) ?? 0) };
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
  // «Свой диапазон» calendar popover (the DateRangePicker → global period `range`, URL-persisted).
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => {
    if (!pickerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickerOpen]);
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

  // Pinned chart point (steep's point drill): set by a click on the line/bar, anchors the
  // «Точка · день» panel under the chart. Any change of what the chart SHOWS un-pins — an index
  // into the old series would silently point at a different day.
  const [pinned, setPinned] = useState<number | null>(null);
  // Primitive deps ONLY (range?.from/to, not the object): an unstable identity would re-fire
  // this after every render and instantly wipe a fresh pin.
  useEffect(() => {
    setPinned(null);
  }, [rawKey, days, range?.from, range?.to, grain, rawChart, cmp]);

  const derived = useMemo(
    () => deriveKpis(data, history, channelsData, channelId, days, range, inRange),
    [data, history, channelsData, channelId, days, range, inRange],
  );
  const chartH = useExplorerChartHeight();

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

  // Data-source line: which channel these numbers come from, so the metric reads self-explanatory
  // (steep «источник данных кристально понятен»). The metric page is Telegram-scoped.
  const currentChannel = channelsData?.channels.find((c) => c.id === channelId);
  const channelHandle = currentChannel?.username ? `@${currentChannel.username}` : currentChannel?.title ?? null;

  // ── Windows: active + comparison baseline ─────────────────────────────────────────────
  const winTo = range ? range.to : Date.now();
  const winFrom = range ? range.from : days > 0 ? winTo - (days - 1) * DAY_MS : null;
  const spanMs = winFrom != null ? winTo - winFrom : null;
  // comparisonWindow encapsulates the day-aligned baseline (its off-by-one once silently
  // dropped the on-chart comparison — see lib/metricSeries + metricSeries.test).
  const baseWin =
    cmp === 'off' || winFrom == null || spanMs == null ? null : comparisonWindow(winFrom, winTo, cmp);
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
  // Do the LOADED posts reach the baseline window start? Posts are fetch-capped (~100), so a prev/
  // year baseline often predates the oldest loaded post — then a per-post sum undercounts and the
  // comparison is nonsense (the +969% vs a −9% archive hero). Gate the post-derived ghost + rail
  // comparison on this. Archive-based paths (subscribers) are unaffected. See baselineCoveredByPosts.
  const baseCovered = baseWin
    ? baselineCoveredByPosts(normPostsAll.map((p) => (p.date ? Date.parse(p.date) : NaN)), baseWin.from)
    : false;

  let series: DailySeries;
  let ghost: number[] | undefined;
  const viewsFromArchive = metricKey === 'views' && historyRows.some((r) => r.views != null && inRange(r.day));
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
  } else if (viewsFromArchive) {
    // Channel-wide daily views from the archive — the line/bar sums to the (channel) headline, not
    // the post-view sum. The rank/pivot breakdowns below stay post-based on purpose (a channel daily
    // series has no per-post dimension; they answer "which posts/hours drove views").
    const inWin = historyRows.filter((r) => inRange(r.day));
    series = bucketedHistoryFlow(inWin, winFrom, winTo, effGrain);
    if (baseWin) {
      const baseRows = historyRows.filter((r) => {
        const t = Date.parse(r.day);
        return Number.isFinite(t) && t >= baseWin.from && t <= baseWin.to;
      });
      const base = bucketedHistoryFlow(baseRows, baseWin.from, baseWin.to, effGrain);
      const gv = alignGhost(base.values, series.values.length);
      if (gv.some((v) => v > 0)) ghost = gv;
    }
  } else if (field) {
    series =
      winFrom != null && winDays <= 400
        ? bucketedPostSeries(normPosts, field, winFrom, winTo, effGrain)
        : bucketedPostSeries(normPosts, field, null, winTo, effGrain);
    if (baseWin && baseCovered) {
      const base = bucketedPostSeries(postsInBase, field, baseWin.from, baseWin.to, effGrain);
      // Align to the active length as a safety net (a residual off-by-one on odd ranges must
      // not silently drop the comparison): the previous period can overshoot by a day at the
      // tail, so keep the leading buckets; pad the front with zeros if short.
      const gv = alignGhost(base.values, series.values.length);
      if (gv.some((v) => v > 0)) ghost = gv;
    }
  } else {
    series = { labels: [], values: [] };
  }

  const valueFmt = metricKey === 'subscribers' ? fmt.num : fmt.short;
  const titles = series.values.map((v, i) => `${series.labels[i]}: ${valueFmt(v)}`);

  // Уровневая метрика (Подписчики): бары УРОВНЯ от нуля почти все во всю высоту — падение
  // визуально теряется (скриншот владельца: «непонятно, что происходит падение»). Как на
  // домашней «Истории подписчиков», режим «Столбцы» рисует ДНЕВНОЕ ИЗМЕНЕНИЕ дивергентными
  // барами вокруг нуля — так спад читается сразу. Поток-метрики (просмотры/реакции/…) — обычные
  // столбцы от нуля (сумма имеет смысл).
  const isLevel = !ZERO_BASED[metricKey];
  const levelDeltas = useMemo(() => {
    const v: number[] = [], l: string[] = [], t: string[] = [];
    if (isLevel) {
      for (let i = 1; i < series.values.length; i++) {
        const d = series.values[i] - series.values[i - 1];
        v.push(d);
        l.push(series.labels[i]);
        t.push(`${series.labels[i]}: ${d >= 0 ? '+' : '−'}${fmt.num(Math.abs(d))}`);
      }
    }
    return { values: v, labels: l, titles: t };
  }, [isLevel, series]);

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
  // Gate the rank/pivot per-dimension compare on the same baseline coverage as the rail + ghost —
  // otherwise the rank "compare" pairs undercount (loaded posts don't span the baseline) and would
  // disagree with the now-suppressed rail «Изменение» (sibling of the +969% fix).
  const baseByDim = field && baseWin && baseCovered ? sumByDim(postsInBase) : null;
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
      reconcile = `ER = ${fmt.short(fieldSumAll)} вовлечений ÷ ${fmt.num(members)} ${pluralRu(members, ['подписчика', 'подписчиков', 'подписчиков'])} × 100% = ${meta.total}`;
    } else if (metricKey === 'avgReach' && normPosts.length > 0) {
      reconcile = `Средний охват = ${fmt.short(fieldSumAll)} просмотров ÷ ${normPosts.length} ${pluralRu(normPosts.length, ['пост', 'поста', 'постов'])} = ${meta.total}`;
    } else if (!viewsFromArchive && contributors.length > 0 && contribTotal > 0 && fieldSumAll > 0) {
      // Suppressed for channel-wide views: «% от периода» here is a share of the POST-view sum,
      // which would contradict the channel headline. The top-posts list itself still shows below.
      reconcile =
        contributors.length === 1
          ? `Этот пост дал ${Math.round((contribTotal / fieldSumAll) * 100)}% от периода.`
          : `Эти ${contributors.length} ${pluralRu(contributors.length, ['пост', 'поста', 'постов'])} дали ${Math.round((contribTotal / fieldSumAll) * 100)}% от периода.`;
    }
  }

  // ── «Сравнение» numbers vs the chosen baseline ────────────────────────────────────────
  const compare = (() => {
    if (!baseWin || cmp === 'off') return null;
    if (viewsFromArchive) {
      // Channel-wide views: compare window sums from the archive (matches the channel headline),
      // not the post-view sum.
      const sumViews = (rows: typeof historyRows) =>
        rows.reduce((s, r) => (r.views != null ? s + Number(r.views) : s), 0);
      const cur = sumViews(historyRows.filter((r) => inRange(r.day)));
      const base = sumViews(
        historyRows.filter((r) => {
          const t = Date.parse(r.day);
          return Number.isFinite(t) && t >= baseWin.from && t <= baseWin.to;
        }),
      );
      if (base === 0) return null;
      return { current: fmt.kpi(cur), previous: fmt.kpi(base), cur, base };
    }
    if (field) {
      // No baseline posts, OR the loaded window doesn't reach the baseline start (sum would
      // undercount → a nonsense %) → suppress rather than mislead. Subscribers use the archive below.
      if (postsInBase.length === 0 || !baseCovered) return null;
      const cur = fieldSumAll;
      const base = postsInBase.reduce((s, p) => s + Number(p[field] ?? 0), 0);
      if (metricKey === 'er' && members > 0) {
        return { current: `${((cur / members) * 100).toFixed(2)}%`, previous: `${((base / members) * 100).toFixed(2)}%`, cur, base };
      }
      if (metricKey === 'avgReach') {
        const curAvg = normPosts.length ? cur / normPosts.length : 0;
        const baseAvg = base / postsInBase.length;
        return { current: fmt.kpi(curAvg), previous: fmt.kpi(baseAvg), cur: curAvg, base: baseAvg };
      }
      return { current: fmt.kpi(cur), previous: fmt.kpi(base), cur, base };
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

  // ── Pinned point resolution ────────────────────────────────────────────────────────────
  // Posts are addressable only on the DAY grain of a bounded window (bucket keys run
  // winFrom..winTo, so index ↔ calendar day is exact) and only for post-derived metrics;
  // elsewhere the panel shows the numbers without a post list.
  const pinnedValid = pinned != null && pinned >= 0 && pinned < series.values.length ? pinned : null;
  // Дельта-бары уровневой метрики (DivergingBars) кликов не несут — пин только для line и
  // обычных столбцов потока.
  const pinnedIsChart = chartType === 'line' || (chartType === 'bar' && !isLevel);
  const canResolveDay = field != null && effGrain === 'day' && winFrom != null;
  const pinnedDayKey = pinnedValid != null && canResolveDay ? localDayKey(winFrom! + pinnedValid * DAY_MS) : null;
  const pinnedPosts = pinnedDayKey
    ? normPosts
        .filter((p) => p.date && localDayKey(Date.parse(p.date)) === pinnedDayKey)
        .sort((a, b) => Number(b[field!] ?? 0) - Number(a[field!] ?? 0))
        .slice(0, 5)
    : [];
  const pinnedDiff = pinnedValid != null && pinnedValid > 0 ? series.values[pinnedValid] - series.values[pinnedValid - 1] : null;

  return (
    <div className="space-y-5">
      {/* Breadcrumb back to the ledger the metric was opened from. */}
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
        <span aria-hidden="true">←</span> Обзор
      </Link>

      {/* Headline — COMPACT (steep): the topbar h1 already names the metric, so this is one
          baseline row (number · Δ · window/source context), not a stacked hero block — the
          chart below owns the vertical space. Same value/Δ/caption as the Overview ledger. */}
      <div>
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span className="text-hero font-medium leading-none tabular-nums tracking-tight">{meta.total}</span>
          <DeltaPill delta={meta.trend} />
          {/* Без имени метрики: h1 в топбаре уже называет её — повтор в 60px читался дублем. */}
          <span className="text-xs tracking-wide text-muted-foreground">
            {periodLabel}
            {channelHandle ? <span className="text-ink3"> · Telegram {channelHandle}</span> : null}
          </span>
        </div>
        {meta.caption ? <div className="mt-1.5 text-xs text-muted-foreground">{meta.caption}</div> : null}
      </div>

      <div className="grid grid-cols-1 gap-6 xl:gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        {/* Main column — the big chart in four projections + contributing posts. */}
        <div className="min-w-0 space-y-8">
          <ChartWidget
            id={`metric-${metricKey}`}
            title={chartTitle}
            defaultSize="full"
            noExpand
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
                  height={chartH}
                  markExtremes
                  markAnomalies={effGrain === 'day' && (metricKey === 'views' || metricKey === 'subscribers')}
                  showPoints={series.values.length > 1 && series.values.length <= 45}
                  ghost={ghost}
                  ghostLabel={cmp !== 'off' ? CMP_CHIP[cmp] : undefined}
                  legendToggle={false}
                  yMin={ZERO_BASED[metricKey] && series.values.length > 1 ? 0 : undefined}
                  onPointClick={(i) => setPinned((p) => (p === i ? null : i))}
                  pinnedIndex={pinnedValid}
                />
              </ChartExpandedContext.Provider>
            )}
            {chartType === 'bar' && (
              /* Expanded context switches BarChart into its rich mode (y ticks + value labels). */
              <ChartExpandedContext.Provider value={true}>
                {isLevel ? (
                  // Уровень → дневное изменение (дивергентные бары вокруг нуля). Без ghost/пина —
                  // DivergingBars их не несёт, паритет с домашней «Историей».
                  <DivergingBars
                    values={levelDeltas.values}
                    labels={levelDeltas.labels}
                    titles={levelDeltas.titles}
                    height={chartH}
                  />
                ) : (
                  <BarChart
                    values={series.values}
                    labels={series.labels}
                    titles={titles}
                    height={chartH}
                    ghost={ghost}
                    ghostLabel={cmp !== 'off' ? CMP_CHIP[cmp] : undefined}
                    legendToggle={false}
                    onPointClick={(i) => setPinned((p) => (p === i ? null : i))}
                    pinnedIndex={pinnedValid}
                  />
                )}
              </ChartExpandedContext.Provider>
            )}
            {chartType === 'rank' && (
              <RankChart items={rankItems} valueFmt={fmt.short} compareLabel={cmpLabel} />
            )}
            {chartType === 'pivot' && (
              <PivotTable columns={pivot.columns} rows={pivot.rows} valueFmt={fmt.short} />
            )}
          </ChartWidget>

          {pinnedValid != null && pinnedIsChart && (
            <PinnedDayPanel
              dateLabel={series.labels[pinnedValid] ?? ''}
              rows={[
                { label: 'Значение', value: fmt.num(series.values[pinnedValid]) },
                ...(pinnedDiff != null
                  ? [
                      {
                        label: 'К пред. точке',
                        value: (
                          <span className={pinnedDiff > 0 ? 'text-verdant' : pinnedDiff < 0 ? 'text-ember' : undefined}>
                            {pinnedDiff > 0 ? '+' : pinnedDiff < 0 ? '−' : ''}
                            {fmt.num(Math.abs(pinnedDiff))}
                          </span>
                        ),
                      },
                    ]
                  : []),
                ...(ghost && ghost[pinnedValid] != null
                  ? [{ label: cmpLabel ?? 'База', value: fmt.num(ghost[pinnedValid]) }]
                  : []),
              ]}
              posts={pinnedPosts.map((post) => ({
                key: post.id ?? post.date ?? '',
                thumb: post.thumb ? `${post.thumb}?size=sm` : null,
                text: post.caption ? markdownToPlainText(post.caption) : 'Без подписи',
                value: fmt.short(Number(post[field!] ?? 0)),
                onOpen: () => setOpenPost(post),
              }))}
              showPosts={canResolveDay}
              onClose={() => setPinned(null)}
            />
          )}

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
        <aside className="space-y-6">
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
                    В загруженных постах недостаточно данных за {cmpLabel} — сравнить не с чем.
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
      {/* Тулбар — канон sticky-хедеров (solid bg + hairline, без blur/тени/полупрозрачности):
          плавающий полупрозрачный пилл читался как баг — строки «Топ постов» просвечивали сквозь. */}
      <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-2 border-t border-border bg-background px-4 py-2 sm:-mx-6 sm:px-6 print:hidden">
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
            aria-pressed={!range && days === chip.days}
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
        {/* «Свой диапазон» — opens the calendar picker; applies to the global period `range`
            (URL-persisted, used everywhere via inRange). The active range is shown by the chip below. */}
        <div className="relative">
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((v) => !v)}
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
              range ? 'border-primary/40 text-primary' : 'border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            Свой диапазон
          </button>
          {pickerOpen && (
            <>
              <div className="fixed inset-0 z-popover" onClick={() => setPickerOpen(false)} aria-hidden="true" />
              <div
                role="dialog"
                aria-label="Свой диапазон дат"
                className="absolute bottom-full right-0 z-popover mb-2 rounded-lg border border-border bg-popover p-3"
              >
                <DateRangePicker
                  value={range}
                  onApply={(r) => {
                    setRange(r);
                    setPickerOpen(false);
                  }}
                  onReset={() => {
                    setRange(null);
                    setPickerOpen(false);
                  }}
                />
              </div>
            </>
          )}
        </div>
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
export function SegSelect<T extends string>({
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
    <div className="space-y-5">
      <Skeleton className="h-3 w-16" />
      <div>
        <Skeleton className="h-8 w-48" />
      </div>
      <div className="grid grid-cols-1 gap-6 xl:gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <Skeleton className="h-[420px] w-full" />
        <div className="space-y-4">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      </div>
    </div>
  );
}
