import { useEffect, useMemo, useState } from 'react';
import { InspectorHandle } from '@/components/InspectorHandle';
import type { ReactNode } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAnnotations, useChannels, useHistory, useTgFull } from '@/api/queries';
import { apiSend } from '@/api/client';
import { useSelectedChannel } from '@/lib/channel-context';
import { usePeriod } from '@/lib/period';
import type { PeriodDays } from '@/lib/period';
import { deriveKpis, isDrillKey } from '@/lib/kpiDerive';
import type { DailySeries, DrillKey, PostMetricField } from '@/lib/kpiDerive';
import { getDrillMetric } from '@/lib/widgetMetrics';
import { addWidgetForMetric } from '@/lib/widgetStore';
import { pinToHome } from '@/lib/widgetPrefsStore';
import { customKey } from '@/lib/widgetConfig';
import { fmt, pluralRu } from '@/lib/format';
import { cn } from '@/lib/utils';
import { markdownToPlainText } from '@/lib/markdown';
import { PinnedDayPanel } from '@/components/PinnedDayPanel';
import type { NormalizedPost } from '@/lib/posts';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ErrorState';
import { DeltaPill } from '@/components/DeltaPill';
import { SegmentedControl } from '@/components/SegmentedControl';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { DivergingBars } from '@/components/DivergingBars';
import { ChartExpandedContext } from '@/components/ExpandableChart';
import { Breakdown } from '@/components/Breakdown';
import { RankChart } from '@/components/RankChart';
import { PivotTable } from '@/components/PivotTable';
import { PostDetailModal } from '@/components/PostDetailModal';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { DateRangePicker } from '@/components/DateRangePicker';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { lttbDownsample } from '@/lib/downsample';
import { DAY_MS, alignGhost, baselineCoveredByPosts, bucketKeyOf, bucketKeysInWindow, comparisonWindow } from '@/lib/metricSeries';
import type { Grain } from '@/lib/metricSeries';
import { CHART_MAX_POINTS, pickIndexes } from '@/lib/msSeries';
import { useExplorerChartHeight } from '@/lib/useExplorerChartHeight';
import { splitDailyWindows } from '@/lib/delta';
import { MediaThumb } from '@/components/MediaThumb';

/** Короткий день недели для тултипов дневной гранулы («чт, 2 июл») — артефакт v2. */
const WEEKDAY_FMT = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });

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

function postThumbLabel(post: NormalizedPost): string {
  if (post.mediaType === 'video') return 'Видео';
  if (post.mediaType === 'photo') return post.albumSize > 1 ? 'Альбом' : 'Фото';
  if (post.mediaType === 'document') return 'Файл';
  return 'Текст';
}

function smallThumbUrl(src: string | null): string | null {
  if (!src) return null;
  return `${src}${src.includes('?') ? '&' : '?'}size=sm`;
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
  const { data, isPending, isError, error } = useTgFull(days, { windowPair: true });
  const { data: history } = useHistory(730);
  const { channelId } = useSelectedChannel();
  // Флажки-события на линии (артефакт v2 п.7): бэкенд chart_annotations существовал без фронта.
  const annotationsQuery = useAnnotations(channelId);
  const queryClient = useQueryClient();
  const [annLabel, setAnnLabel] = useState('');
  const [annBusy, setAnnBusy] = useState(false);
  const [annError, setAnnError] = useState<string | null>(null);
  // Состояние «Закрепить на Главной» — ЗДЕСЬ, выше early-return'ов (условный хук = React #310).
  const [pinnedToHome, setPinnedToHome] = useState(false);
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

  const def = getDrillMetric(metricKey);
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
  const archiveWindowPair =
    !range && days > 0
      ? splitDailyWindows(historyRows, (row) => Number(row.views ?? Number.NaN), days, winTo)
      : null;
  const activeViewsRows = archiveWindowPair?.current.rows ?? historyRows.filter((row) => inRange(row.day));
  const baselineViewsRows = !baseWin
    ? []
    : cmp === 'prev' && !range && days > 0
      ? archiveWindowPair?.previous.rows ?? []
      : historyRows.filter((row) => {
          const timestamp = Date.parse(row.day);
          return Number.isFinite(timestamp) && timestamp >= baseWin.from && timestamp <= baseWin.to;
        });

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
  const viewsFromArchive = metricKey === 'views' && activeViewsRows.some((row) => row.views != null);
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
    series = bucketedHistoryFlow(activeViewsRows, winFrom, winTo, effGrain);
    if (baseWin && baselineViewsRows.length > 0) {
      const base = bucketedHistoryFlow(baselineViewsRows, baseWin.from, baseWin.to, effGrain);
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
  // День недели в тултипе (артефакт v2, steep): «чт, 2 июл: 2 800». Только на дневной грануле
  // ограниченного окна — там индекс ↔ календарный день точен (та же арифметика, что pinnedDayKey).
  const dayAddressable = effGrain === 'day' && winFrom != null;
  const titles = series.values.map((v, i) => {
    const wd = dayAddressable ? `${WEEKDAY_FMT.format(new Date(winFrom! + i * DAY_MS))}, ` : '';
    return `${wd}${series.labels[i]}: ${valueFmt(v)}`;
  });
  // Заголовки структурной ховер-карточки (дата с днём недели, без значения) + СВОИ даты строк
  // сравнения («Пред. период · вт, 18 июн» — артефакт v2 п.5).
  const hoverTitles = dayAddressable
    ? series.values.map((_, i) => `${WEEKDAY_FMT.format(new Date(winFrom! + i * DAY_MS))}, ${series.labels[i]}`)
    : undefined;
  const ghostTitles =
    dayAddressable && baseWin
      ? series.values.map((_, i) => `${WEEKDAY_FMT.format(new Date(baseWin.from + i * DAY_MS))}, ${fmt.day(baseWin.from + i * DAY_MS)}`)
      : undefined;
  // Флажки: день аннотации ('YYYY-MM-DD') → индекс точки текущего окна; несколько событий одного
  // дня склеиваются в одну подпись.
  const annotations = annotationsQuery.data?.annotations ?? [];
  const chartFlags = (() => {
    if (!dayAddressable || annotations.length === 0) return undefined;
    const indexByDay = new Map<string, number>();
    for (let i = 0; i < series.values.length; i++) indexByDay.set(localDayKey(winFrom! + i * DAY_MS), i);
    const byIndex = new Map<number, string>();
    for (const a of annotations) {
      const i = indexByDay.get(a.day);
      if (i == null) continue;
      byIndex.set(i, byIndex.has(i) ? `${byIndex.get(i)} · ${a.label}` : a.label);
    }
    return byIndex.size > 0 ? [...byIndex].map(([i, label]) => ({ i, label })) : undefined;
  })();

  // Уровневая метрика (Подписчики): бары УРОВНЯ от нуля почти все во всю высоту — падение
  // визуально теряется (скриншот владельца: «непонятно, что происходит падение»). Как на
  // домашней «Истории подписчиков», режим «Столбцы» рисует ДНЕВНОЕ ИЗМЕНЕНИЕ дивергентными
  // барами вокруг нуля — так спад читается сразу. Поток-метрики (просмотры/реакции/…) — обычные
  // столбцы от нуля (сумма имеет смысл).
  // NB: обычное вычисление, НЕ useMemo — этот код ниже early-return'ов (Navigate/isError выше),
  // а условный хук = React #310 «rendered more hooks». Цикл ≤~90 точек, дёшев на каждый рендер.
  const isLevel = !ZERO_BASED[metricKey];
  const levelDeltas = (() => {
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
  })();

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
      const sumViews = (rows: typeof historyRows) => rows.reduce(
        (sum, row) => (row.views != null && Number.isFinite(Number(row.views)) ? sum + Number(row.views) : sum),
        0,
      );
      const cur = archiveWindowPair && cmp === 'prev' && !range
        ? archiveWindowPair.current.total
        : sumViews(activeViewsRows);
      const base = archiveWindowPair && cmp === 'prev' && !range
        ? archiveWindowPair.previous.total
        : sumViews(baselineViewsRows);
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

  // «Закрепить на Главной» (артефакт v2, страничные действия): метрика в один клик становится
  // виджетом персональной доски — дефолтный конфиг + пин, тем же путём, что каталог Главной.
  const pinMetricToHome = () => {
    if (pinnedToHome) return;
    const w = addWidgetForMetric(getDrillMetric(metricKey).id);
    if (w) {
      pinToHome(customKey(w.id));
      setPinnedToHome(true);
    }
  };

  // Разрыв-вместо-нуля (артефакт v2 п.9): канальные «Просмотры» идут из дневного архива —
  // пропущенный день там означает пропуск СБОРА, а не ноль («ноль-которого-не-было» — ложь
  // дашборда). Дыру несёт только ЛИНИЯ на дневной грануле; bar/рейтинг остаются плотностными
  // видами, а post-derived метрики не трогаем — их ноль честный (в тот день не публиковали).
  const archiveDays = viewsFromArchive
    ? new Set(
        historyRows
          .filter((r) => r.views != null)
          .map((r) => localDayKey(Date.parse(r.day)))
      )
    : null;
  const gapAware = (vals: number[], fromMs: number | null): Array<number | null> => {
    if (!archiveDays || effGrain !== 'day' || fromMs == null) return vals;
    return vals.map((v, i) => (archiveDays.has(localDayKey(fromMs + i * DAY_MS)) ? v : null));
  };
  const lineValues = gapAware(series.values, winFrom);
  const lineGhost = ghost ? gapAware(ghost, baseWin?.from ?? null) : ghost;

  // Кап длинной ЛИНИИ (канон CLAUDE.md: длинные серии даунсэмплятся до CHART_MAX_POINTS перед
  // рендером): «Всё» отдаёт дневной архив целиком — до 730 точек уходили в LineChart сырыми.
  // ТОЛЬКО когда день НЕ адресуется индексом (dayAddressable): дневная адресация — weekday-тултипы,
  // флажки-событий и пин дня — считает дату как winFrom + i·DAY_MS, и прореженный индекс лгал бы.
  // Bar/rank/pivot и панель пина остаются на ПОЛНОЙ серии (децимация столбцов врёт пропусками
  // дней); sampledLineIdx маппит точку прореженной линии обратно в индекс полной серии. С ghost —
  // pickIndexes (единые индексы обеих линий — канон msSeries для мультисерий), без ghost форму
  // держит LTTB; null-разрывы для отбора формы читаются как 0, в отрисовку идут как null.
  const sampledLineIdx = (() => {
    if (dayAddressable || lineValues.length <= CHART_MAX_POINTS) return null;
    if (lineGhost) return pickIndexes(lineValues.length, CHART_MAX_POINTS);
    const all = lineValues.map((_, i) => i);
    return lttbDownsample(all, CHART_MAX_POINTS, (i) => lineValues[i] ?? 0);
  })();
  const lineChart = sampledLineIdx
    ? {
        values: sampledLineIdx.map((i) => lineValues[i] ?? null),
        labels: sampledLineIdx.map((i) => series.labels[i] ?? ''),
        titles: sampledLineIdx.map((i) => titles[i] ?? ''),
        ghost: lineGhost ? sampledLineIdx.map((i) => lineGhost[i] ?? null) : undefined,
      }
    : { values: lineValues, labels: series.labels, titles, ghost: lineGhost };

  // ── События дня (chart_annotations): создание/удаление из панели пина ────────────────────
  const addAnnotation = async (dayKey: string) => {
    const label = annLabel.trim();
    if (!label || !channelId || annBusy) return;
    setAnnBusy(true);
    setAnnError(null);
    try {
      await apiSend('POST', `/api/channels/${channelId}/annotations`, { day: dayKey, label });
      setAnnLabel('');
      await queryClient.invalidateQueries({ queryKey: ['annotations', channelId] });
    } catch {
      setAnnError('Не удалось сохранить событие — нужны права участника воркспейса.');
    } finally {
      setAnnBusy(false);
    }
  };
  const removeAnnotation = async (annId: number) => {
    if (!channelId || annBusy) return;
    setAnnBusy(true);
    setAnnError(null);
    try {
      await apiSend('DELETE', `/api/channels/${channelId}/annotations/${annId}`);
      await queryClient.invalidateQueries({ queryKey: ['annotations', channelId] });
    } catch {
      setAnnError('Не удалось удалить событие.');
    } finally {
      setAnnBusy(false);
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
  // Позиция пина НА ПРОРЕЖЕННОЙ линии (pinned хранит индекс полной серии — панель пина и
  // соседняя дельта считаются от полных данных).
  const pinnedLineIndex = (() => {
    if (pinnedValid == null || !sampledLineIdx) return pinnedValid;
    const pos = sampledLineIdx.indexOf(pinnedValid);
    return pos === -1 ? null : pos;
  })();
  // Дельта-бары уровневой метрики (DivergingBars) кликов не несут — пин только для line и
  // обычных столбцов потока.
  const pinnedIsChart = chartType === 'line' || (chartType === 'bar' && !isLevel);
  const canResolveDay = field != null && effGrain === 'day' && winFrom != null;
  const pinnedDayKey = pinnedValid != null && canResolveDay ? localDayKey(winFrom! + pinnedValid * DAY_MS) : null;
  const pinnedDayFlags = pinnedDayKey ? annotations.filter((a) => a.day === pinnedDayKey) : [];
  const pinnedPosts = pinnedDayKey
    ? normPosts
        .filter((p) => p.date && localDayKey(Date.parse(p.date)) === pinnedDayKey)
        .sort((a, b) => Number(b[field!] ?? 0) - Number(a[field!] ?? 0))
        .slice(0, 5)
    : [];
  const pinnedDiff = pinnedValid != null && pinnedValid > 0 ? series.values[pinnedValid] - series.values[pinnedValid - 1] : null;

  return (
    <div className="space-y-4">
      {/* Breadcrumb + страничные действия (артефакт v2): «Закрепить» кладёт метрику на Главную. */}
      <div className="flex items-center justify-between gap-3">
        <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
          <span aria-hidden="true">←</span> Обзор
        </Link>
        <button
          type="button"
          onClick={pinMetricToHome}
          disabled={pinnedToHome}
          className="btn-pill inline-flex items-center gap-1.5 border border-border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-70 print:hidden"
        >
          {pinnedToHome ? '✓ На Главной' : 'Закрепить на Главной'}
        </button>
      </div>

      {/* Headline v2 (артефакт владельца): страница ведёт ИМЕНЕМ метрики — тихая шапка, только
          идентичность. Итог окна живёт в «Сравнении» справа (сумма окна из графика не читается,
          hero в шапке её дублировал); период — в тайм-баре под графиком. На <lg rail уезжает под
          график, поэтому компактный итог остаётся в шапке только там. The metric route
          deliberately has no global topbar. */}
      <div>
        <h1 className="text-2xl font-medium tracking-tight text-foreground">{def.label}</h1>
        {channelHandle ? (
          <div className="mt-1 text-xs tracking-wide text-muted-foreground">Telegram {channelHandle}</div>
        ) : null}
        <div className="mt-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 lg:hidden">
          <span className="text-3xl font-medium leading-none tabular-nums tracking-tight">{meta.total}</span>
          <DeltaPill delta={meta.trend} />
          <span className="text-xs tracking-wide text-muted-foreground">{periodLabel}</span>
        </div>
        {meta.caption ? <div className="mt-1.5 text-xs text-muted-foreground">{meta.caption}</div> : null}
      </div>

      {/* relative + InspectorHandle: тянущаяся ширина инспектора (см. components/InspectorHandle). */}
      <div className="relative grid grid-cols-1 gap-6 xl:gap-7 lg:grid-cols-[minmax(0,1fr)_var(--inspector-w,280px)]">
        <InspectorHandle defaultWidth={280} />
        {/* Main column — the big chart in four projections + contributing posts. */}
        <div className="min-w-0 space-y-6">
          {/* Chart card (артефакт: связная карточка) — заголовок + переключатель типа + меню одной
              панелью-тулбаром сверху, канвас в теле, тайм-бар футером снизу; единый скруглённый
              бордер вместо плавающих контролов у края и отдельной border-top-полосы. */}
          <div
            data-metric-chart-card
            className="rounded-2xl border border-border bg-card p-4 shadow-xs dark:border-white/6 sm:p-5"
          >
          <ChartWidget
            id={`metric-${metricKey}`}
            title={chartTitle}
            defaultSize="full"
            noExpand
            strip
            stripToolbar
            action={
              <SegmentedControl
                ariaLabel="Тип графика"
                className="shrink-0"
                segmentClassName="h-7 min-w-8 gap-1.5 px-2"
                value={chartType}
                onChange={(next) => setParam('chart', next === 'line' ? null : next)}
                options={chartTypes.map((kind) => ({
                  value: kind,
                  content: (
                    <>
                      <ChartTypeIcon kind={kind} />
                      <span className="hidden xl:inline">{CHART_TYPE_LABEL[kind]}</span>
                    </>
                  ),
                  ariaLabel: `Тип графика: ${CHART_TYPE_LABEL[kind]}`,
                  title: CHART_TYPE_LABEL[kind],
                }))}
              />
            }
          >
            {chartType === 'line' && (
              /* Expanded context: the metric page's big chart always renders the full y-axis
                 (dashboards are axis-free; the explorer is where the scale lives). */
              <ChartExpandedContext.Provider value={true}>
                <LineChart
                  values={lineChart.values}
                  labels={lineChart.labels}
                  titles={lineChart.titles}
                  hoverTitles={hoverTitles}
                  ghostTitles={ghostTitles}
                  flags={chartFlags}
                  height={chartH}
                  appearance="comparison"
                  markExtremes
                  markAnomalies={effGrain === 'day' && (metricKey === 'views' || metricKey === 'subscribers')}
                  ghost={lineChart.ghost}
                  primaryLabel="Текущий период"
                  ghostLabel={cmp !== 'off' ? CMP_CHIP[cmp] : undefined}
                  legendToggle={false}
                  yMin={ZERO_BASED[metricKey] && series.values.length > 1 ? 0 : undefined}
                  onPointClick={(i) => {
                    // Пин хранит индекс ПОЛНОЙ серии (sampledLineIdx маппит клик обратно).
                    const oi = sampledLineIdx ? sampledLineIdx[i] : i;
                    // Дыру не пинить: у пропущенного дня нет ни значения, ни постов.
                    if (lineValues[oi] == null) return;
                    setPinned((p) => (p === oi ? null : oi));
                  }}
                  pinnedIndex={pinnedLineIndex}
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
                    appearance="comparison"
                    ghost={ghost}
                    primaryLabel="Текущий период"
                    ghostLabel={cmp !== 'off' ? CMP_CHIP[cmp] : undefined}
                    comparisonStyle="stacked"
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

          {/* Тайм-бар — футер карточки графика (артефакт v2): гранулярность слева, пресеты окна,
              свой диапазон и пейджер окон одной строкой под канвасом. Контролы держат единую
              высоту (h-7) и радиусы, поэтому читаются одной панелью. Пикер открывается вниз. */}
          <div
            data-metric-toolbar
            className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3 dark:border-white/6 print:hidden"
          >
            <SegmentedControl
              ariaLabel="Гранулярность"
              value={effGrain}
              onChange={(g) => setParam('grain', g === 'day' ? null : g)}
              options={(['day', 'week', 'month'] as Grain[]).map((g) => ({
                value: g,
                content: GRAIN_LABEL[g],
                disabled: !grainAllowed[g],
              }))}
            />
            <span className="flex-1" />
            {/* Presets on the shared sliding-glider primitive; a picked custom range deselects every
                preset (value matches nothing → the glider hides). */}
            <SegmentedControl
              ariaLabel="Период"
              value={range ? '' : String(days)}
              onChange={(d) => setDays(Number(d) as PeriodDays)}
              options={[
                { value: '7', content: '7д' },
                { value: '30', content: '30д' },
                { value: '90', content: '90д' },
                { value: '0', content: 'Всё' },
              ]}
            />
            {/* «Свой диапазон» — opens the calendar picker; applies to the global period `range`
                (URL-persisted, used everywhere via inRange). The active range is shown by the chip below. */}
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={`inline-flex h-7 items-center rounded-full border px-3 text-xs font-medium transition-colors ${
                    range ? 'border-primary/40 text-primary' : 'border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Свой диапазон
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" sideOffset={8} className="w-auto p-3">
                <DateRangePicker
                  value={range}
                  onApply={(nextRange) => {
                    setRange(nextRange);
                    setPickerOpen(false);
                  }}
                  onReset={() => {
                    setRange(null);
                    setPickerOpen(false);
                  }}
                />
              </PopoverContent>
            </Popover>
            {range && (
              <button
                type="button"
                onClick={() => setRange(null)}
                title="Сбросить произвольный период"
                className="inline-flex h-7 items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-3 text-xs font-medium text-primary"
              >
                {fmt.day(range.from)} – {fmt.day(range.to)} <span aria-hidden="true">×</span>
              </button>
            )}
            {/* Пейджер окон — единой пилюлей с бордером (как одна двухкнопочная деталь тулбара). */}
            <div className="inline-flex h-7 items-center rounded-full border border-border">
              <button
                type="button"
                onClick={() => shiftWindow(-1)}
                disabled={winFrom == null}
                aria-label="Предыдущее окно"
                className="inline-flex h-full items-center rounded-l-full px-2 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                ‹
              </button>
              <span aria-hidden="true" className="h-4 w-px bg-border" />
              <button
                type="button"
                onClick={() => shiftWindow(1)}
                disabled={!range}
                aria-label="Следующее окно"
                className="inline-flex h-full items-center rounded-r-full px-2 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                ›
              </button>
            </div>
          </div>
          </div>

          {pinnedValid != null && pinnedIsChart && (
            <PinnedDayPanel
              appearance="detail"
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
                thumb: smallThumbUrl(post.thumb),
                thumbLabel: postThumbLabel(post),
                text: post.caption ? markdownToPlainText(post.caption) : 'Без подписи',
                value: fmt.short(Number(post[field!] ?? 0)),
                onOpen: () => setOpenPost(post),
              }))}
              showPosts={canResolveDay}
              onClose={() => setPinned(null)}
              footer={
                pinnedDayKey ? (
                  <div
                    data-pinned-day-events
                    className="mt-4 rounded-xl border border-border bg-background/40 p-3 dark:border-white/6"
                  >
                    {/* События дня (chart_annotations): пин уже выбрал день — здесь событие
                        создаётся и удаляется; флажок ⚑ появляется на линии. */}
                    {pinnedDayFlags.length > 0 && (
                      <div className="space-y-1.5">
                        {pinnedDayFlags.map((a) => (
                          <div key={a.id} className="flex items-center gap-2 text-xs">
                            <span aria-hidden="true" className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">⚑</span>
                            <span className="min-w-0 flex-1 truncate text-foreground">{a.label}</span>
                            <button
                              type="button"
                              aria-label={`Удалить событие «${a.label}»`}
                              title="Удалить событие"
                              disabled={annBusy}
                              onClick={() => void removeAnnotation(a.id)}
                              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-destructive disabled:opacity-40"
                            >
                              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
                              </svg>
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <form
                      className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void addAnnotation(pinnedDayKey);
                      }}
                    >
                      <input
                        value={annLabel}
                        onChange={(e) => setAnnLabel(e.target.value)}
                        maxLength={80}
                        placeholder="Отметить событие дня — реклама, пост-хит…"
                        className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-card px-3 text-xs text-foreground outline-hidden placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
                      />
                      <button
                        type="submit"
                        disabled={!annLabel.trim() || annBusy}
                        className="btn-pill inline-flex h-9 shrink-0 items-center justify-center border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
                      >
                        ⚑ Отметить
                      </button>
                    </form>
                    {annError && <p className="mt-1.5 text-2xs text-ember">{annError}</p>}
                  </div>
                ) : undefined
              }
            />
          )}

          {field && (
            <section
              data-metric-top-posts
              className="overflow-hidden rounded-2xl border border-border bg-card shadow-xs dark:border-white/6"
            >
              <header className="flex items-end justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
                <div className="min-w-0">
                  <div className="text-2xs font-medium tracking-wide text-muted-foreground">Публикации</div>
                  <h3 className="mt-1 truncate text-sm font-semibold tracking-tight text-foreground">
                    Топ постов по {CONTRIB_LABEL[metricKey] ?? 'метрике'}
                  </h3>
                </div>
                {contributors.length > 0 && (
                  <span className="shrink-0 rounded-full border border-border bg-background px-2.5 py-1 text-2xs tabular-nums text-muted-foreground">
                    {contributors.length} в рейтинге
                  </span>
                )}
              </header>
              {contributors.length > 0 ? (
                (() => {
                  // Полоса под подписью — доля относительно лидера списка (не периода): #1 всегда
                  // заполнен, дальше виден спад. Числовой процент справа остаётся долей периода.
                  const topValue = Number(contributors[0]?.[field] ?? 0);
                  return (
                    <>
                      <div
                        aria-hidden="true"
                        className="hidden grid-cols-[2rem_2.5rem_minmax(0,1fr)_6rem] items-center gap-3 border-b border-border bg-muted/25 px-5 py-2 text-2xs font-medium tracking-wide text-muted-foreground sm:grid"
                      >
                        <span className="text-center">№</span>
                        <span />
                        <span>Публикация</span>
                        <span className="text-right">Результат</span>
                      </div>
                      <ol>
                      {contributors.map((post, i) => {
                        const value = Number(post[field] ?? 0);
                        const share = fieldSumAll > 0 ? Math.round((value / fieldSumAll) * 100) : 0;
                        const barPct = topValue > 0 ? Math.max(2, Math.round((value / topValue) * 100)) : 0;
                        const text = post.caption ? markdownToPlainText(post.caption) : 'Без подписи';
                        const format = postThumbLabel(post);
                        const selected = openPost === post || (!!openPost?.id && openPost.id === post.id);
                        return (
                          <li
                            key={post.id ?? i}
                            data-top-post-row
                            data-top-post-selected={selected ? '' : undefined}
                            className="border-t border-border/70 first:border-t-0"
                          >
                            <button
                              type="button"
                              aria-pressed={selected}
                              onClick={() => setOpenPost(post)}
                              className={cn(
                                'grid w-full grid-cols-[1.75rem_2.5rem_minmax(0,1fr)_auto] items-center gap-2.5 px-4 py-3 text-left transition-colors sm:grid-cols-[2rem_2.5rem_minmax(0,1fr)_6rem] sm:gap-3 sm:px-5',
                                'hover:bg-muted/45 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/45',
                                selected && 'bg-primary/8 hover:bg-primary/10',
                              )}
                            >
                              <span
                                className={cn(
                                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-2xs font-semibold tabular-nums',
                                  i === 0
                                    ? 'bg-primary text-primary-foreground'
                                    : i < 3
                                      ? 'bg-primary/10 text-primary'
                                      : 'text-muted-foreground',
                                )}
                              >
                                {i + 1}
                              </span>
                              <MediaThumb
                                src={smallThumbUrl(post.thumb)}
                                label={format}
                                className="h-10 w-10 rounded-lg"
                              />
                              <span className="min-w-0 flex-1">
                                <span className="line-clamp-2 block text-xs font-medium leading-5 text-foreground sm:text-sm">
                                  {text}
                                </span>
                                <span
                                  data-top-post-format
                                  className="mt-1 inline-flex rounded-full border border-border bg-background px-1.5 py-0.5 text-2xs leading-none text-muted-foreground"
                                >
                                  {format}
                                </span>
                                <span className="mt-1.5 block h-1 w-full overflow-hidden rounded-full bg-muted">
                                  <span
                                    className="block h-full rounded-full transition-[width]"
                                    style={{
                                      width: `${barPct}%`,
                                      backgroundColor: 'hsl(var(--chart-role-primary) / 0.72)',
                                    }}
                                  />
                                </span>
                              </span>
                              <span className="min-w-15 shrink-0 text-right sm:min-w-0">
                                <span className="block text-sm font-semibold tabular-nums text-foreground">
                                  {fmt.short(value)}
                                </span>
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
                      </ol>
                    </>
                  );
                })()
              ) : (
                <div className="px-5 py-10 text-center text-sm text-muted-foreground">
                  Недостаточно данных за период.
                </div>
              )}
              {reconcile && (
                <p className="border-t border-border bg-muted/20 px-4 py-3 text-xs leading-relaxed text-muted-foreground sm:px-5">
                  {reconcile}
                </p>
              )}
            </section>
          )}
        </div>

        {/* Composer rail (артефакт): аналитические карточки вместо волосяных секций у бордюра.
            «Сравнение» первым и с явной иерархией — итог окна доминирует, база и Δ вторичны;
            ниже — Разбивка и «О метрике» той же карточной иерархией. */}
        <aside className="space-y-4">
          <RailCard title="Сравнение" mark="comparison">
            {/* Итог окна — доминанта карточки (hero переехал сюда после тихой шапки). */}
            <div className="text-2xs tracking-wide text-muted-foreground">Текущий период</div>
            <div className="mt-1 text-3xl font-medium leading-none tabular-nums text-foreground">{meta.total}</div>
            {winFrom == null ? (
              <p className="mt-3 text-xs text-muted-foreground">Для окна «Всё» прошлого периода не существует.</p>
            ) : (
              <div className="mt-4">
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
                  <p className="text-xs text-muted-foreground">Выберите базу — серия сравнения, пары в рейтинге и Δ появятся автоматически.</p>
                ) : compare ? (
                  <div className="space-y-3">
                    {/* Значение базы — вторичный вес; Δ — цветной бейдж (прирост/спад). */}
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-xs text-muted-foreground">{cmpLabel}</span>
                      <span className="text-base font-medium tabular-nums text-ink2">{compare.previous}</span>
                    </div>
                    {compareDelta != null && (
                      <div className="flex items-center justify-between gap-3 border-t border-border pt-3 dark:border-white/6">
                        <span className="text-xs text-muted-foreground">Изменение</span>
                        <DeltaBadge value={compareDelta} />
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    В загруженных постах недостаточно данных за {cmpLabel} — сравнить не с чем.
                  </p>
                )}
              </div>
            )}
          </RailCard>

          {field && (
            <RailCard title="Разбивка" mark="breakdown">
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
            </RailCard>
          )}

          <RailCard title="О метрике" mark="about">
            <dl className="space-y-3 text-sm">
              {def.formula && <AboutRow label="Как считается" text={def.formula} />}
              {def.included && <AboutRow label="Что учитывается" text={def.included} />}
              {def.source && <AboutRow label="Источник" text={def.source} />}
            </dl>
          </RailCard>

          <Link
            to="/analytics"
            className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary/80"
          >
            Открыть аналитику <span aria-hidden="true">→</span>
          </Link>
        </aside>
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

/** Bounded segmented control for the rail selects (dimension / comparison baseline) — a thin,
    full-width wrapper over the shared {@link SegmentedControl} so the rail matches every other
    segmented group by construction. */
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
    <SegmentedControl
      ariaLabel={ariaLabel}
      className="mb-3 w-full"
      segmentClassName="px-2"
      value={value}
      onChange={onChange}
      options={options.map((opt) => ({ value: opt.value, content: opt.label }))}
    />
  );
}

const CHART_TYPE_LABEL = { line: 'Линия', bar: 'Столбцы', rank: 'Рейтинг', pivot: 'Сводная' } as const;

/** The steep Explore glyph for a chart-type segment (icon-only; its label rides `aria-label`). */
function ChartTypeIcon({ kind }: { kind: 'line' | 'bar' | 'rank' | 'pivot' }) {
  return (
    <>
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
    </>
  );
}

/** Analytical rail card — a titled rounded surface shared by Сравнение / Разбивка / О метрике, so
    the rail reads as a stack of cards rather than disconnected hairline sections. */
function RailCard({ title, mark, children }: { title: string; mark?: string; children: ReactNode }) {
  return (
    <section
      data-rail-card={mark}
      className="rounded-2xl border border-border bg-card p-4 shadow-xs dark:border-white/6 sm:p-5"
    >
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Colour-coded change badge for the comparison card — the one evaluated Δ that leans on tone
    (gain = verdant, loss = ember); direction also rides the ▲/▼ glyph for colour-blind safety. */
function DeltaBadge({ value }: { value: number }) {
  const up = value > 0;
  const down = value < 0;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${
        up ? 'bg-verdant/10 text-verdant' : down ? 'bg-ember/10 text-ember' : 'bg-muted text-muted-foreground'
      }`}
    >
      <span aria-hidden="true">{up ? '▲' : down ? '▼' : '—'}</span>
      {Math.abs(value).toFixed(1)}%
    </span>
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
