import { useCallback, useMemo } from 'react';
import { useTgFull, useTgGraphs } from '@/api/queries';
import type { TgFull, TgGraphs } from '@/api/schemas';
import { lttbDownsample } from '@/lib/downsample';
import { CHART_MAX_POINTS } from '@/lib/msSeries';
import { normalizeTgPosts } from '@/lib/posts';
import { compareDdMm } from '@/lib/dates';
import { fmt, ruAxisLabel, ruSeriesName, ddmmDay, pluralRu } from '@/lib/format';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { ChartCardBody, ChartSection } from '@/components/ChartWidget';
import { WidgetGroup } from '@/components/widgets/WidgetGroup';
import { breakdownVariants, seriesBarValuesVariant } from '@/components/widgets/variants';
import { Breakdown } from '@/components/Breakdown';
import { pctDelta } from '@/lib/delta';
import { DivergingBars } from '@/components/DivergingBars';
import { EmptyState } from '@/components/EmptyState';
import {
  calendarWindowForDays,
  calendarWindowForPeriod,
  splitCalendarRows,
  useWidgetPeriod,
} from '@/lib/period';
import type { CalendarWindow, WidgetPeriodValue } from '@/lib/period';
import type { WidgetSeriesOpts } from '@/lib/widgetPrefsStore';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

const SRC_NAMES: Record<string, string> = {
  Followers: 'Подписчики',
  URL: 'Ссылки',
  Search: 'Поиск',
  'Telegram Search': 'Поиск',
  Groups: 'Группы',
  Channels: 'Каналы',
  PM: 'Личные сообщения',
  Other: 'Прочее',
  'Shareable Chat Folders': 'Папки',
  'Shareable Folder Links': 'Папки',
};

const SENT_NAME: Record<string, string> = {
  Positive: 'Положительные',
  Other: 'Прочие',
  Negative: 'Отрицательные',
};

// Sentiment coding via colour dots (Breakdown), not emoji: verdant = positive, ember = negative,
// ink3 = neutral/other — consistent with the delta palette (verdant up / ember down).
const SENT_COLOR: Record<string, string> = {
  Positive: 'hsl(var(--brand-verdant))',
  Other: 'hsl(var(--ink3))',
  Negative: 'hsl(var(--brand-ember))',
};

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Chart sections render as customisable widgets (components/ChartWidget) — card surface,
// per-widget accent/tint menu. Supersedes the old local hairline section (FH3 dedupe).

export type TgAnalyticsGroup = 'dynamics' | 'audience' | 'content';

const WD_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

const formatMsDate = (ts: number) => {
  const d = new Date(ts);
  // ruAxisLabel: axis labels/tooltips must read Russian («18 May» → «18 мая»).
  return ruAxisLabel(`${d.getDate()} ${MON[d.getMonth()] ?? ''}`);
};

/** Display options for a daily-flow series (the widget's edit-dialog «Грануляция» /
    «Включая сегодня»). Mirrors WidgetSeriesOpts, both fields optional at this layer. */
interface GraphSeriesOpts {
  grain?: 'day' | 'week' | 'month';
  includeToday?: boolean;
}

/** Rich-expand windowing for a graphs (daily-flow) series over a CALENDAR window (`win`, epoch ms;
    `null` = «Всё»), with ms-timestamp labels + RU tooltips. Windowing by date — not by slicing the
    last N points — is what makes the series honour the page top bar (including a custom «Свой»
    range) and show the true current window even when the archive is stale or gappy. Points whose
    timestamp falls in [win.from, win.to] are kept; a series without usable timestamps returns all it
    has (honest — never fabricates points). Optional opts: drop today's partial point («Включая
    сегодня» off) and bucket the window by ISO week (Monday anchor) or calendar month — sums, since
    these are flow metrics. */
export function windowGraphSeries(values: number[], xs: number[], win: CalendarWindow | null, unit: string, opts?: GraphSeriesOpts) {
  let vals = values;
  let xss = xs;
  if (opts?.includeToday === false && xss.length) {
    const last = new Date(xss[xss.length - 1]!);
    const now = new Date();
    if (
      last.getFullYear() === now.getFullYear() &&
      last.getMonth() === now.getMonth() &&
      last.getDate() === now.getDate()
    ) {
      vals = vals.slice(0, -1);
      xss = xss.slice(0, -1);
    }
  }
  const selected = splitCalendarRows(
    vals.map((value, index) => ({ value, timestamp: Number(xss[index] ?? Number.NaN) })),
    win,
    (row) => row.timestamp,
  );
  let wValues = selected.current.map((row) => row.value);
  let wxs = selected.current.map((row) => row.timestamp);
  const grain = opts?.grain ?? 'day';
  if (grain !== 'day') {
    const buckets = new Map<string, { sum: number; anchor: number }>();
    wValues.forEach((v, i) => {
      const ts = wxs[i];
      if (ts == null) return;
      const d = new Date(ts);
      let key: string;
      let anchor: number;
      if (grain === 'month') {
        key = `${d.getFullYear()}-${d.getMonth()}`;
        anchor = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
      } else {
        const back = (d.getDay() + 6) % 7; // Monday-anchored week bucket
        const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
        key = `${mon.getFullYear()}-${mon.getMonth()}-${mon.getDate()}`;
        anchor = mon.getTime();
      }
      const b = buckets.get(key);
      if (b) b.sum += v;
      else buckets.set(key, { sum: v, anchor });
    });
    const rows = [...buckets.values()].sort((a, b) => a.anchor - b.anchor);
    wValues = rows.map((r) => r.sum);
    wxs = rows.map((r) => r.anchor);
  }
  const labels = wValues.map((_, i) => (wxs[i] ? formatMsDate(wxs[i]!) : ''));
  const suffix = grain === 'week' ? ' · неделя' : grain === 'month' ? ' · месяц' : '';
  const titles = wValues.map((v, i) => `${labels[i]}: ${fmt.num(v)} ${unit}${suffix}`);
  // Headline for the steep card anatomy: the window's total + the PREVIOUS same-length window's
  // total (pre-bucketing daily values — grain only re-shapes the chart). prevTotal is null when
  // the comparison would be dishonest: «Всё» has no previous window, there are no timestamps to
  // place the previous window on, or the archive doesn't reach back far enough to cover it (a
  // partial comparison we never fabricate).
  const total = wValues.reduce((acc, v) => acc + v, 0);
  const prevTotal = selected.previous
    ? selected.previous.reduce((sum, row) => sum + row.value, 0)
    : null;
  return { values: wValues, labels, titles, total, prevTotal };
}

/** Кап ЛИНЕЙНОГО представления длинной серии (канон CLAUDE.md: длинные серии даунсэмплятся через
    lttbDownsample до CHART_MAX_POINTS перед рендером): окно «Всё» отдаёт архив graphs целиком —
    до 730 дневных точек уходили в LineChart сырыми. LTTB держит форму, labels/titles сжимаются
    теми же выбранными точками. ТОЛЬКО для линий: столбцы и леджер «Столбцы + значения» остаются
    на полной серии — децимация баров врёт пропусками дней, а молча менять гранулярность нельзя.
    Итог/prevTotal не трогаем — они уже посчитаны от полного окна (кап чисто визуальный). */
function capLineSeries<T extends { values: number[]; labels: string[]; titles: string[] }>(w: T): T {
  if (w.values.length <= CHART_MAX_POINTS) return w;
  const rows = w.values.map((value, i) => ({ value, label: w.labels[i] ?? '', title: w.titles[i] ?? '' }));
  const sampled = lttbDownsample(rows, CHART_MAX_POINTS, (row) => row.value);
  return {
    ...w,
    values: sampled.map((row) => row.value),
    labels: sampled.map((row) => row.label),
    titles: sampled.map((row) => row.title),
  };
}

/**
 * All normalisation/aggregation for the TG analytics sections, extracted so the component
 * can memoize it — previously these ~180 lines re-ran on every render for all four tab
 * groups. Pure: depends only on the three query payloads + the period predicate.
 */
function deriveTgAnalytics(
  full: TgFull | undefined,
  graphs: TgGraphs | undefined,
  inRange: (dateISO: string | null | undefined) => boolean,
) {
  const vs = full?.views_summary;

  // 2) Views by day — «dd.mm» keys sorted with year-rollover inference (Dec < Jan across NY).
  const viewsByDayRaw: Record<string, number> = vs?.views_by_day ?? {};
  const sortedDates = Object.keys(viewsByDayRaw).sort((a, b) => compareDdMm(a, b));
  const last14Dates = sortedDates.slice(-14);
  const vbdValues = last14Dates.map((d) => Number(viewsByDayRaw[d] ?? 0));
  // Канонный вид дат («3 июл.»), не сырые dd.mm-ключи API (аудит).
  const vbdTitles = last14Dates.map((d) => `${ddmmDay(d)}: ${fmt.num(viewsByDayRaw[d] ?? 0)} просмотров`);
  // Ghost overlay = the previous equal-length window (the "vs прошлый период" comparison on the chart).
  const prev14Dates = sortedDates.slice(-28, -14);
  const vbdPrev = prev14Dates.length >= 2 ? prev14Dates.map((d) => Number(viewsByDayRaw[d] ?? 0)) : undefined;

  // 6) Views & reposts — two separate widgets (daily FLOWS, so zero-based bars are honest).
  // (The subscriber-LEVEL «Рост подписчиков» card lived here; removed as a duplicate — the level
  // trend is «История подписчиков» (full archive + rich explorer) and the daily net is «Чистый
  // прирост подписчиков» below, so a third level+delta card only repeated both.)
  const interGroup = graphs?.interactions;
  const interSeries = interGroup?.series ?? [];
  const viewSeries = interSeries.find((s) => /view|просмотр/i.test(s.name ?? ''));
  const shareSeries = interSeries.find((s) => /share|forward|репост|пересыл/i.test(s.name ?? ''));

  // 8) Sources / languages / sentiment
  const mapSourceItems = (
    arr: Array<{ label?: string | null; value?: number | null }> | null | undefined,
    mapper?: Record<string, string>,
    colorMapper?: Record<string, string>,
  ) => {
    if (!arr) return [];
    return arr
      .map((item) => {
        const rawLabel = item.label ?? '';
        return {
          label: mapper ? mapper[rawLabel] || rawLabel : rawLabel,
          value: Number(item.value ?? 0),
          color: colorMapper ? colorMapper[rawLabel] : undefined,
          display: fmt.num(Number(item.value ?? 0)),
        };
      })
      .filter((item) => item.value > 0);
  };
  const vbsItems = mapSourceItems(graphs?.views_by_source, SRC_NAMES);
  const nfsItems = mapSourceItems(graphs?.new_followers_by_source, SRC_NAMES);
  // Языки: длинный хвост из десятков языков делал плитку сильно выше коротких соседей —
  // топ-8, тот же кэп, что у эмодзи/стран/городов (и у леджера «Столбцы + значения»).
  const langItems = mapSourceItems(graphs?.languages)
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
  const sentItems = mapSourceItems(graphs?.reactions_sentiment, SENT_NAME, SENT_COLOR);

  // 9) Hours
  const thData = graphs?.top_hours;
  const hasHours = thData && thData.values.length > 0;
  let peakHourStr = '';
  if (hasHours && thData) {
    const argmax = thData.values.indexOf(Math.max(...thData.values));
    peakHourStr = `пик активности ~ ${thData.hours[argmax] ?? argmax}:00`;
  }

  // 10) Net subscribers
  const fGroup = graphs?.followers;
  const fSeries = fGroup?.series ?? [];
  const joinedSeries = fSeries.find((s) => /join|подпис/i.test(s.name ?? ''));
  const leftSeries = fSeries.find((s) => /left|отпис/i.test(s.name ?? ''));

  // Whole-payload existence probe only. Both follower-flow card bodies re-derive from the resolved
  // page/Home window, so no all-time totals are allowed to leak into a bounded feed period.
  const netGrowthPresent = Boolean(
    joinedSeries && leftSeries && Math.min(joinedSeries.values.length, leftSeries.values.length) > 0,
  );

  // 12) Weekday — filtered by the resolved feed/Home window (previously iterated all fetched posts).
  const wdViews: number[] = Array(7).fill(0);
  const wdCount: number[] = Array(7).fill(0);
  full?.posts?.forEach((p) => {
    if (!p.date || !inRange(p.date)) return;
    const day = new Date(p.date).getDay();
    wdViews[day] += Number(p.views ?? p.view_count ?? 0);
    wdCount[day] += 1;
  });
  const wdOrder = [1, 2, 3, 4, 5, 6, 0];
  const wdAvgValues = wdOrder.map((idx) => {
    const count = wdCount[idx] ?? 0;
    return count ? Math.round((wdViews[idx] ?? 0) / count) : 0;
  });
  const wdCountValues = wdOrder.map((idx) => wdCount[idx] ?? 0);
  const maxWdAvg = Math.max(...wdAvgValues);
  const bestWdLabel = maxWdAvg > 0 ? WD_LABELS[wdAvgValues.indexOf(maxWdAvg)] ?? '' : '';

  return {
    last14Dates, vbdValues, vbdTitles, vbdPrev,
    interGroup, viewSeries, shareSeries,
    vbsItems, nfsItems, langItems, sentItems,
    thData, hasHours, peakHourStr,
    netGrowthPresent,
    wdAvgValues, wdCountValues, maxWdAvg, bestWdLabel,
  };
}

/** All-data window predicate — the panel-level derive uses it so that (a) which sections EXIST
    is decided by the whole fetched payload (sections don't pop in/out as a card's window changes)
    and (b) graphs-driven series (period-agnostic anyway) render their full server window. */
const alwaysInRange = () => true;

// ── Focused period derives ──────────────────────────────────────────────────────────────────
// Post-derived charts recompute from the resolved feed/Home window (variants-fn form passes
// inRange). Focused helpers avoid re-running the whole
// deriveTgAnalytics pass — each touches only the ≤100 fetched posts it needs.

const TYPE_NAMES: Record<string, string> = {
  photo: 'Фото', video: 'Видео', poll: 'Опросы', document: 'Файлы',
  text: 'Текст', audio: 'Аудио', voice: 'Голос', link: 'Ссылки',
};

type InRange = (dateISO: string | null | undefined) => boolean;
type Keep = (postId: number | null | undefined) => boolean;
const keepAll: Keep = () => true;

/** Normalised in-window posts, optionally scoped to the selected campaign's members (`keep`). One
    place so every content derive filters on the same (date-in-window AND campaign) predicate. */
function contentPosts(full: TgFull | undefined, inRange: InRange, keep: Keep) {
  return normalizeTgPosts(full?.posts ?? [], full?.channel ?? {}).filter(
    (p) => inRange(p.date) && keep(p.id),
  );
}

/** «Реакции по эмодзи» — top-8 emoji reactions over the in-window posts. */
function deriveEmojis(full: TgFull | undefined, inRange: InRange, keep: Keep = keepAll) {
  const posts = contentPosts(full, inRange, keep);
  const emojiMap: Record<string, number> = {};
  posts.forEach((p) => {
    p.reactionsDetail.forEach((rd) => {
      if (rd.emoji) emojiMap[rd.emoji] = (emojiMap[rd.emoji] ?? 0) + rd.count;
    });
  });
  return Object.entries(emojiMap)
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
}

/** «Вовлечённость по формату» — avg ERV per media type over the in-window posts. */
function deriveFormatPerf(full: TgFull | undefined, inRange: InRange, keep: Keep = keepAll) {
  const posts = contentPosts(full, inRange, keep);
  const g: Record<string, { n: number; ervSum: number; ervN: number }> = {};
  posts.forEach((p) => {
    const t = p.mediaType || 'text';
    (g[t] ??= { n: 0, ervSum: 0, ervN: 0 }).n++;
    if (p.erv != null) {
      g[t].ervSum += p.erv;
      g[t].ervN++;
    }
  });
  return Object.entries(g)
    .map(([t, v]) => ({ label: TYPE_NAMES[t] || t, avgErv: v.ervN ? v.ervSum / v.ervN : 0, n: v.n }))
    .filter((x) => x.n > 0 && x.avgErv > 0)
    .sort((a, b) => b.avgErv - a.avgErv);
}

/** «Состав вовлечённости» from raw posts (reactions/forwards/replies sums) — used when a campaign is
    selected, so the split reflects the campaign's own posts for the source, NOT the channel-wide
    views_summary totals (which can't be scoped to a campaign). */
function deriveCompositionFromPosts(full: TgFull | undefined, inRange: InRange, keep: Keep) {
  const posts = contentPosts(full, inRange, keep);
  const reactions = posts.reduce((s, p) => s + p.likes, 0);
  const forwards = posts.reduce((s, p) => s + p.shares, 0);
  const replies = posts.reduce((s, p) => s + p.comments, 0);
  return [
    { label: 'Реакции', value: reactions, color: 'hsl(var(--chart-1))' },
    { label: 'Репосты', value: forwards, color: 'hsl(var(--chart-2))' },
    { label: 'Комментарии', value: replies, color: 'hsl(var(--chart-3))' },
  ].filter((item) => item.value > 0);
}

/** «Ср. охват по типу» from raw posts (avg views per media type) — the campaign-scoped counterpart
    to views_summary.avg_views_by_type, computed only over the campaign's posts for the source. */
function deriveViewsByTypeFromPosts(full: TgFull | undefined, inRange: InRange, keep: Keep) {
  const posts = contentPosts(full, inRange, keep);
  const g: Record<string, { sum: number; n: number }> = {};
  posts.forEach((p) => {
    const t = p.mediaType || 'text';
    (g[t] ??= { sum: 0, n: 0 });
    g[t].sum += p.reach;
    g[t].n++;
  });
  return Object.entries(g)
    .map(([t, v]) => ({ label: TYPE_NAMES[t] || t, value: v.n ? Math.round(v.sum / v.n) : 0 }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value);
}

/** Weekday avg-views + post-count over the in-window posts (fixes the old all-posts bug). */
function deriveWeekday(full: TgFull | undefined, inRange: InRange) {
  const wdViews: number[] = Array(7).fill(0);
  const wdCount: number[] = Array(7).fill(0);
  full?.posts?.forEach((p) => {
    if (!p.date || !inRange(p.date)) return;
    const day = new Date(p.date).getDay();
    wdViews[day] += Number(p.views ?? p.view_count ?? 0);
    wdCount[day] += 1;
  });
  const wdOrder = [1, 2, 3, 4, 5, 6, 0];
  const wdAvgValues = wdOrder.map((idx) => {
    const count = wdCount[idx] ?? 0;
    return count ? Math.round((wdViews[idx] ?? 0) / count) : 0;
  });
  const wdCountValues = wdOrder.map((idx) => wdCount[idx] ?? 0);
  const maxWdAvg = Math.max(...wdAvgValues);
  const bestWdLabel = maxWdAvg > 0 ? WD_LABELS[wdAvgValues.indexOf(maxWdAvg)] ?? '' : '';
  return { wdAvgValues, wdCountValues, maxWdAvg, bestWdLabel };
}

/** Joined, left and signed net follower flows over one resolved calendar window. */
export function deriveFollowerFlows(graphs: TgGraphs | undefined, win: CalendarWindow | null) {
  const empty = {
    values: [] as number[],
    titles: [] as string[],
    total: 0,
    prevTotal: null as number | null,
    joinedTotal: 0,
    leftTotal: 0,
  };
  const fGroup = graphs?.followers;
  const fSeries = fGroup?.series ?? [];
  const joined = fSeries.find((s) => /join|подпис/i.test(s.name ?? '')) || fSeries[0];
  const left = fSeries.find((s) => /left|отпис/i.test(s.name ?? '')) || fSeries[1];
  if (!joined || !left) return empty;
  const fx = fGroup?.x ?? [];
  const mLen = Math.min(joined.values.length, left.values.length);
  const rows: Array<{ timestamp: number; joined: number; left: number; net: number }> = [];
  for (let i = 0; i < mLen; i++) {
    const joinedValue = Number(joined.values[i] ?? 0);
    const leftValue = Number(left.values[i] ?? 0);
    rows.push({
      timestamp: Number(fx[i] ?? Number.NaN),
      joined: joinedValue,
      left: leftValue,
      net: joinedValue - leftValue,
    });
  }
  const selected = splitCalendarRows(rows, win, (row) => row.timestamp);
  const values = selected.current.map((row) => row.net);
  const titles = selected.current.map((row) => {
    const label = Number.isFinite(row.timestamp) ? formatMsDate(row.timestamp) : '';
    return `${label}: ${row.net >= 0 ? '+' : ''}${fmt.num(row.net)} за день`;
  });
  return {
    values,
    titles,
    total: values.reduce((sum, value) => sum + value, 0),
    prevTotal: selected.previous
      ? selected.previous.reduce((sum, row) => sum + row.net, 0)
      : null,
    joinedTotal: selected.current.reduce((sum, row) => sum + row.joined, 0),
    leftTotal: selected.current.reduce((sum, row) => sum + row.left, 0),
  };
}

/** Backward-compatible focused shape used by the net-growth card and its tests. */
export function deriveNetGrowth(graphs: TgGraphs | undefined, win: CalendarWindow | null) {
  const { values, titles, total, prevTotal } = deriveFollowerFlows(graphs, win);
  return { values, titles, total, prevTotal };
}

/** «Лучший день» reads the same resolved window as its chart. */
function WeekdayBestDay({ full }: { full: TgFull | undefined }) {
  const { inRange } = useWidgetPeriod();
  const { bestWdLabel } = deriveWeekday(full, inRange);
  if (!bestWdLabel) return null;
  return (
    <div className="mt-3 text-xs font-medium text-muted-foreground">
      лучший день: <strong className="text-foreground">{bestWdLabel}</strong>
    </div>
  );
}

/** «N всего» под строками «Динамики оттока» — reads the same resolved window as its rows. */
function FollowerFlowTotal({ graphs }: { graphs: TgGraphs | undefined }) {
  const period = useWidgetPeriod();
  const flow = deriveFollowerFlows(graphs, calendarWindowForPeriod(period));
  if (flow.values.length === 0) return null;
  return (
    <div className="mt-3 text-xs font-medium text-muted-foreground">
      {fmt.num(flow.joinedTotal + flow.leftTotal)} всего
    </div>
  );
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function formatAverage(value: number | null): string {
  if (value == null) return '—';
  const formatted = Math.abs(value) < 10 ? value.toFixed(1) : fmt.kpi(value);
  return formatted;
}

function formatRate(value: number | null): string {
  return value == null ? '—' : `${value.toFixed(1)}%`;
}

/**
 * Dynamics summary derived from the same raw posts and page period as the cards below. The former
 * server snapshot ignored the header period and produced rows of zeroes/dashes; this ledger stays
 * internally comparable and updates with the page-wide period control.
 */
function TgAnalyticsSummary({ full }: { full: TgFull | undefined }) {
  const { inRange } = useWidgetPeriod();
  const posts = normalizeTgPosts(full?.posts ?? [], full?.channel ?? {}).filter((post) => inRange(post.date));

  if (posts.length === 0) {
    return <p className="border-t border-border py-5 text-sm text-muted-foreground">В выбранном периоде нет публикаций для сводки.</p>;
  }

  const erv = average(posts.map((post) => post.erv).filter((value): value is number => value != null));
  const virality = average(posts.map((post) => post.virality).filter((value): value is number => value != null));
  const cappedSample = posts.length >= 100;
  // Captions must fit the tile without ellipsis («вовлечённость на пр…»); full wording, when it
  // adds anything, lives in captionTitle → title-атрибут.
  const items: { label: string; value: string; caption: string; captionTitle?: string }[] = [
    { label: 'Ср. просмотры', value: formatAverage(average(posts.map((post) => post.reach))), caption: cappedSample ? 'по последним 100 публ.' : `по ${fmt.num(posts.length)} публ.` },
    { label: 'Публикации', value: fmt.num(posts.length), caption: cappedSample ? 'выборка периода, до 100' : 'в выбранном периоде' },
    { label: 'Ср. ERV', value: formatRate(erv), caption: 'на просмотр', captionTitle: 'вовлечённость на просмотр' },
    { label: 'Виральность', value: formatRate(virality), caption: 'репосты / просмотры' },
    { label: 'Реакций / пост', value: formatAverage(average(posts.map((post) => post.likes))), caption: 'в среднем на пост', captionTitle: 'среднее по публикациям' },
    { label: 'Репостов / пост', value: formatAverage(average(posts.map((post) => post.shares))), caption: 'в среднем на пост', captionTitle: 'среднее по публикациям' },
  ];

  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-4 sm:grid-cols-3 lg:grid-cols-6">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <div className="truncate text-2xs tracking-wide text-muted-foreground">{item.label}</div>
          <div className="mt-1.5 text-2xl font-medium tabular-nums tracking-tight text-foreground">{item.value}</div>
          <div className="mt-1 truncate text-2xs text-muted-foreground" title={item.captionTitle}>{item.caption}</div>
        </div>
      ))}
    </div>
  );
}

/** Campaign scope for the content group only (Analytics «Форматы»). When `active`, the post-derived
    content sections filter to the campaign's members for the source and composition/views-by-type are
    computed FROM those posts instead of the channel-wide views_summary. Undefined ⇒ no filtering. */
export interface TgAnalyticsCampaign {
  active: boolean;
  inCampaign: (postId: number | null | undefined) => boolean;
}

/** `group` renders only that section family (the Analytics tabs); undefined = all sections. The KPI
    ledger always shows as the group header. */
export function TgAnalytics({
  group,
  campaign,
}: { group?: TgAnalyticsGroup; campaign?: TgAnalyticsCampaign } = {}) {
  const inGroup = (g: TgAnalyticsGroup) => !group || group === g;
  // ONE wide fetch (limit 100 = server cap): every widget below filters this shared payload to the
  // resolved window. Source feeds take it from the shared top bar; Home widgets keep their own
  // saved period. ChartSection owns this distinction through PagePeriodProvider.
  const { data: full, isPending: isFullPending } = useTgFull(0);
  const { data: graphs, isPending: isGraphsPending } = useTgGraphs();

  // Panel-level derive over the WHOLE fetched payload (alwaysInRange): section-existence gates +
  // the KPI ledger snapshot + graphs-driven series. Post-derived CHART VALUES are re-derived
  // inside TgWidgetBody from the resolved page/Home-widget window.
  const derived = useMemo(() => deriveTgAnalytics(full, graphs, alwaysInRange), [full, graphs]);
  const {
    last14Dates, vbdValues, vbdTitles, vbdPrev,
    interGroup, viewSeries, shareSeries,
    vbsItems, nfsItems, langItems, sentItems,
    thData, hasHours, peakHourStr,
    netGrowthPresent,
    maxWdAvg,
  } = derived;

  // Content group, campaign-scoped: a source is (tg, channelId); when a campaign is selected the
  // post-derived sections keep only its members, and composition/views-by-type switch from the
  // channel-wide views_summary to the campaign's own posts (the summary can't be campaign-scoped).
  // `keep` is a pass-through when no campaign is active, so the non-campaign path is byte-identical.
  const keep: Keep = campaign?.active ? campaign.inCampaign : keepAll;
  // Whole-payload (alwaysInRange) versions gate section EXISTENCE — same policy as elsewhere, so a
  // narrow card window that happens to be empty doesn't make the section vanish (its own empty
  // shows). useMemo (перф): раньше четыре пост-derive (normalizeTgPosts ×4 по ≤100 постам)
  // пересчитывались на КАЖДЫЙ рендер страницы — усилитель кадровых штормов.
  const { emojiItems, formatPerfItems, compositionItems, viewsByTypeItems } = useMemo(
    () => ({
      emojiItems: deriveEmojis(full, alwaysInRange, keep),
      formatPerfItems: deriveFormatPerf(full, alwaysInRange, keep),
      compositionItems: deriveCompositionFromPosts(full, alwaysInRange, keep),
      viewsByTypeItems: deriveViewsByTypeFromPosts(full, alwaysInRange, keep),
    }),
    [full, keep],
  );

  // ── Стабильные variants-функции карточек ────────────────────────────────────────────────────
  // useChartSectionModel мемоизирует variants(period, seriesOpts) по IDENTITY самой функции —
  // инлайн-стрелки в JSX пересобирали переданные чартам массивы (и их plot-мемо) на каждом
  // рендере страницы. Все хуки — строго ДО early-return ниже (React #310).
  const emojiVariants = useCallback(
    (period: WidgetPeriodValue) =>
      breakdownVariants(
        deriveEmojis(full, period.inRange, keep).map((e) => ({ label: e.label, value: e.value, display: fmt.num(e.value) })),
      ),
    [full, keep],
  );
  const compositionVariants = useCallback(
    (period: WidgetPeriodValue) =>
      breakdownVariants(
        deriveCompositionFromPosts(full, period.inRange, keep).map((c) => ({
          label: c.label,
          value: c.value,
          display: fmt.num(c.value),
          color: c.color,
        })),
      ),
    [full, keep],
  );
  const viewsByTypeVariants = useCallback(
    (period: WidgetPeriodValue) =>
      breakdownVariants(
        deriveViewsByTypeFromPosts(full, period.inRange, keep).map((t) => ({
          label: t.label,
          value: t.value,
          display: fmt.num(t.value),
        })),
      ),
    [full, keep],
  );
  const formatPerfVariants = useCallback(
    (period: WidgetPeriodValue) =>
      breakdownVariants(
        deriveFormatPerf(full, period.inRange, keep).map((f) => ({ label: f.label, value: f.avgErv, display: `${f.avgErv.toFixed(1)}% ERV · ${f.n} ${pluralRu(f.n, ['пост', 'поста', 'постов'])}` })),
      ),
    [full, keep],
  );
  const viewsVariants = useCallback(
    (period: WidgetPeriodValue, series: WidgetSeriesOpts) => {
      if (!viewSeries || !interGroup) return [];
      // Windowed by the WIDGET period (follows the page top bar — preset AND custom «Свой»
      // range — by default) through the edit-dialog display opts; the steep body adds the
      // window total + the mandatory comparison vs the previous window (honest null on «Всё»).
      const w = windowGraphSeries(viewSeries.values, interGroup.x, calendarWindowForPeriod(period), 'просмотров', series);
      const line = capLineSeries(w);
      const delta = w.prevTotal != null && w.prevTotal > 0 ? pctDelta(w.total, w.prevTotal) : null;
      const caption = delta ? 'к пред. периоду' : period.days === 0 ? 'за всё время' : undefined;
      return [
        {
          key: 'line',
          label: 'Линия',
          render: (
            <ChartCardBody value={fmt.kpi(w.total)} delta={delta} caption={caption}>
              <LineChart values={line.values} labels={line.labels} titles={line.titles} markAnomalies emphasizeLastLabel />
            </ChartCardBody>
          ),
        },
        {
          // Дневные ПОТОКИ (не уровни) — столбцы от нуля здесь честные.
          key: 'bar',
          label: 'Столбцы',
          render: (
            <ChartCardBody value={fmt.kpi(w.total)} delta={delta} caption={caption}>
              <BarChart values={w.values} labels={w.labels} titles={w.titles} />
            </ChartCardBody>
          ),
        },
        seriesBarValuesVariant(w.values, w.labels, w.titles, { sum: true }),
      ];
    },
    [viewSeries, interGroup],
  );
  const sharesVariants = useCallback(
    (period: WidgetPeriodValue, series: WidgetSeriesOpts) => {
      if (!shareSeries || !interGroup) return [];
      const w = windowGraphSeries(shareSeries.values, interGroup.x, calendarWindowForPeriod(period), 'репостов', series);
      const line = capLineSeries(w);
      const delta = w.prevTotal != null && w.prevTotal > 0 ? pctDelta(w.total, w.prevTotal) : null;
      const caption = delta ? 'к пред. периоду' : period.days === 0 ? 'за всё время' : undefined;
      return [
        {
          key: 'line',
          label: 'Линия',
          render: (
            <ChartCardBody value={fmt.kpi(w.total)} delta={delta} caption={caption}>
              <LineChart values={line.values} labels={line.labels} titles={line.titles} emphasizeLastLabel />
            </ChartCardBody>
          ),
        },
        {
          key: 'bar',
          label: 'Столбцы',
          render: (
            <ChartCardBody value={fmt.kpi(w.total)} delta={delta} caption={caption}>
              <BarChart values={w.values} labels={w.labels} titles={w.titles} />
            </ChartCardBody>
          ),
        },
        seriesBarValuesVariant(w.values, w.labels, w.titles, { sum: true }),
      ];
    },
    [shareSeries, interGroup],
  );
  const netGrowthVariants = useCallback(
    (period: WidgetPeriodValue) => {
      const w = deriveNetGrowth(graphs, calendarWindowForPeriod(period));
      const delta = w.prevTotal != null && w.prevTotal > 0 && w.total >= 0 ? pctDelta(w.total, w.prevTotal) : null;
      const caption = delta ? 'к пред. периоду' : period.days === 0 && !period.range ? 'за всё время' : 'за период';
      return [
        {
          key: 'bar',
          label: 'Столбцы',
          render:
            w.values.length > 0 ? (
              <ChartCardBody
                value={`${w.total >= 0 ? '+' : '−'}${fmt.kpi(Math.abs(w.total))}`}
                delta={delta}
                caption={caption}
              >
                <DivergingBars values={w.values} titles={w.titles} />
              </ChartCardBody>
            ) : (
              <EmptyState title="Нет данных за выбранный период." />
            ),
        },
      ];
    },
    [graphs],
  );
  // Аудит: красно-зелёный донат был единственной круговой в продукте. Единственное представление —
  // две строки Breakdown БЕЗ color (нейтральный приглушённый трек --chart-role-primary);
  // «N всего» из центра доната живёт футером (FollowerFlowTotal).
  const churnVariants = useCallback(
    (period: WidgetPeriodValue) => {
      const flow = deriveFollowerFlows(graphs, calendarWindowForPeriod(period));
      if (flow.values.length === 0) {
        return [{ key: 'list', label: 'Список', render: <EmptyState title="Нет данных за выбранный период." /> }];
      }
      const flowTotal = flow.joinedTotal + flow.leftTotal;
      const rowDisplay = (value: number) =>
        flowTotal > 0 ? `${fmt.num(value)} · ${Math.round((value / flowTotal) * 100)}%` : fmt.num(value);
      return [
        {
          key: 'list',
          label: 'Список',
          render: (
            <Breakdown
              items={[
                { label: 'Отписалось', value: flow.leftTotal, display: rowDisplay(flow.leftTotal) },
                { label: 'Подписалось', value: flow.joinedTotal, display: rowDisplay(flow.joinedTotal) },
              ]}
            />
          ),
        },
      ];
    },
    [graphs],
  );
  const weekdayVariants = useCallback(
    (period: WidgetPeriodValue) => {
      const { wdAvgValues } = deriveWeekday(full, period.inRange);
      return [
        {
          key: 'bar',
          label: 'Столбцы',
          render: (
            <div>
              <div className="mb-2 text-2xs tracking-wide text-muted-foreground">Ср. просмотры</div>
              <BarChart values={wdAvgValues} labels={WD_LABELS} titles={wdAvgValues.map((v, i) => `${WD_LABELS[i]}: ${fmt.num(v)} ср. просмотров`)} />
            </div>
          ),
        },
        {
          key: 'line',
          label: 'Линия',
          render: <LineChart values={wdAvgValues} labels={WD_LABELS} titles={wdAvgValues.map((v, i) => `${WD_LABELS[i]}: ${fmt.num(v)} ср. просмотров`)} yMin={0} />,
        },
      ];
    },
    [full],
  );
  const postCountVariants = useCallback(
    (period: WidgetPeriodValue) => {
      const { wdCountValues } = deriveWeekday(full, period.inRange);
      return [
        {
          key: 'bar',
          label: 'Столбцы',
          render: (
            <div className="max-w-[560px]">
              <BarChart values={wdCountValues} labels={WD_LABELS} titles={wdCountValues.map((v, i) => `${WD_LABELS[i]}: ${fmt.num(v)} постов`)} />
            </div>
          ),
        },
        {
          key: 'line',
          label: 'Линия',
          render: (
            <div className="max-w-[560px]">
              <LineChart values={wdCountValues} labels={WD_LABELS} titles={wdCountValues.map((v, i) => `${WD_LABELS[i]}: ${fmt.num(v)} постов`)} yMin={0} />
            </div>
          ),
        },
      ];
    },
    [full],
  );

  if (isFullPending || (group !== 'content' && isGraphsPending)) {
    return <TgAnalyticsSkeletons showSummary={inGroup('dynamics')} />;
  }

  if (!full && !graphs) {
    return <EmptyState title="Данных аналитики пока нет." reason="Как только collector-агент пришлёт первый снимок, здесь появятся графики." />;
  }

  return (
    <div className="space-y-6">
      <WidgetGroup
        id={`tg-${group ?? 'all'}`}
        className={cn(
          // grid-flow-dense: с широкими (full) вариантами обычная раскладка оставляла бы
          // дыры при переносе — плотная упаковка подтягивает узкие плитки в свободные ячейки.
          'grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6',
          // Аудитория: каждая секция — самостоятельная ячейка сетки; при нечётном числе
          // half-плиток последняя дотягивается до полного ряда, чтобы рядом не зияла пустая дыра.
          group === 'audience' && 'lg:[&>section:last-child:nth-child(odd)]:col-span-6',
        )}
      >
        {/* Сводка показателей — the 'strip' contract (unified-feed step 2, hand-rolled):
            a real widget (hide/reorder with its siblings) whose chrome is a bare full-width
            row — a card frame would make a thin ratio strip compete with the charts. */}
        {inGroup('dynamics') && (
          <ChartSection strip id="tg-derived-kpis" title="Сводка показателей" defaultSize="full" noExpand>
            <TgAnalyticsSummary full={full} />
          </ChartSection>
        )}
        {/* Дубль-развязка (аудит 5.1): «Просмотры по дням» (views_summary, фикс-14д + ghost) и
            «Просмотры» (graphs-серия, rich expand/grain) показывали одни и те же дневные просмотры
            на каналах с broadcast-статистикой. Теперь эта карточка — ЧЕСТНЫЙ FALLBACK только для
            каналов без graphs (мелкие/QR: views_summary есть, статистики нет); на больших остаётся
            один rich «Просмотры», а сравнение периодов живёт на метрик-странице просмотров. */}
        {inGroup('dynamics') && !viewSeries && last14Dates.length >= 2 && (
          <ChartSection
            title="Просмотры по дням"
            defaultSize="half"
            drillTo="/metrics/views"
            variants={[
              {
                key: 'line',
                label: 'Линия',
                render: (
                  <>
                    <LineChart values={vbdValues} labels={[last14Dates[0] ?? '', last14Dates[Math.floor(last14Dates.length / 2)] ?? '', last14Dates[last14Dates.length - 1] ?? '']} titles={vbdTitles} markAnomalies markExtremes ghost={vbdPrev} emphasizeLastLabel />
                  </>
                ),
              },
              {
                key: 'bar',
                label: 'Столбцы',
                render: <BarChart values={vbdValues} labels={last14Dates} titles={vbdTitles} />,
              },
            ]}
          />
        )}

        {/* Пост-производный: топ эмодзи считаются по постам выбранного окна (variants-fn form).
            Под фильтром кампании — только по её публикациям из текущего источника. */}
        {inGroup('content') && emojiItems.length > 0 && (
          <ChartSection title="Реакции по эмодзи" periodControl variants={emojiVariants} />
        )}

        {/* Всегда из публикаций выбранного окна; keep дополнительно ограничивает кампанией. */}
        {inGroup('content') && compositionItems.length > 0 && (
          <ChartSection title="Состав вовлечённости" periodControl variants={compositionVariants} />
        )}

        {/* Средний охват формата — по публикациям выбранного окна и выбранной кампании. */}
        {inGroup('content') && viewsByTypeItems.length > 0 && (
          <ChartSection title="Ср. охват по типу" periodControl variants={viewsByTypeVariants} />
        )}

        {/* Пост-производный: средний ERV по формату — по постам выбранного окна и кампании. */}
        {inGroup('content') && formatPerfItems.length > 0 && (
          <ChartSection title="Вовлечённость по формату" periodControl variants={formatPerfVariants} />
        )}

        {/* Раньше «Просмотры и репосты» были ОДНИМ двойным виджетом (два графика в столбик) —
            его карточка была вдвое выше соседних и ломала сетку плиток. Теперь каждый график —
            свой виджет. id-шники явные: на этой же ленте есть «Просмотры по дням», и default
            title-id столкнулся бы. Series names arrive in English from the graphs API —
            localise for the RU UI. */}
        {inGroup('dynamics') && interGroup && viewSeries && (
          <ChartSection
            id="tg-views-graph"
            title={ruSeriesName(viewSeries.name) || 'Просмотры'}
            defaultSize="half"
            drillTo="/metrics/views"
            // Rich explorer (steep): «Развернуть» grows 1М/3М/6М/Всё pills, a line↔bar toggle and a
            // Мин/Макс/Среднее/Сумма strip — windowing the full graphs series the inline card can't.
            // Линия развёрнутого вида капается (capLineSeries); бары/статы — полное окно.
            expand={{
              grainable: true,
              renderExpanded: (days, grain) => {
                const w = capLineSeries(windowGraphSeries(viewSeries.values, interGroup.x, calendarWindowForDays(days), 'просмотров', { grain }));
                return <LineChart values={w.values} labels={w.labels} titles={w.titles} markAnomalies markExtremes emphasizeLastLabel />;
              },
              renderExpandedBar: (days, grain) => {
                const w = windowGraphSeries(viewSeries.values, interGroup.x, calendarWindowForDays(days), 'просмотров', { grain });
                return <BarChart values={w.values} labels={w.labels} titles={w.titles} />;
              },
              statsFor: (days, grain) => windowGraphSeries(viewSeries.values, interGroup.x, calendarWindowForDays(days), 'просмотров', { grain }).values,
            }}
            seriesOptions
            periodControl
            variants={viewsVariants}
          />
        )}
        {inGroup('dynamics') && interGroup && shareSeries && (
          <ChartSection
            id="tg-shares-graph"
            title={ruSeriesName(shareSeries.name) || 'Репосты'}
            defaultSize="half"
            drillTo="/metrics/forwards"
            expand={{
              grainable: true,
              renderExpanded: (days, grain) => {
                const w = capLineSeries(windowGraphSeries(shareSeries.values, interGroup.x, calendarWindowForDays(days), 'репостов', { grain }));
                return <LineChart values={w.values} labels={w.labels} titles={w.titles} markAnomalies markExtremes emphasizeLastLabel />;
              },
              renderExpandedBar: (days, grain) => {
                const w = windowGraphSeries(shareSeries.values, interGroup.x, calendarWindowForDays(days), 'репостов', { grain });
                return <BarChart values={w.values} labels={w.labels} titles={w.titles} />;
              },
              statsFor: (days, grain) => windowGraphSeries(shareSeries.values, interGroup.x, calendarWindowForDays(days), 'репостов', { grain }).values,
            }}
            seriesOptions
            periodControl
            variants={sharesVariants}
          />
        )}

        {inGroup('audience') && vbsItems.length > 0 && (
          <ChartSection title="Просмотры по источникам" variants={breakdownVariants(vbsItems)} />
        )}
        {inGroup('audience') && nfsItems.length > 0 && (
          <ChartSection title="Новые подписчики по источникам" variants={breakdownVariants(nfsItems)} />
        )}
        {inGroup('audience') && langItems.length > 0 && (
          <ChartSection title="Языки аудитории" variants={breakdownVariants(langItems)} />
        )}
        {inGroup('audience') && sentItems.length > 0 && (
          <ChartSection title="Тональность реакций" variants={breakdownVariants(sentItems)} />
        )}

        {inGroup('audience') && hasHours && thData && (
          <ChartSection
            title="Активность по часам"
            variants={[
              {
                key: 'bar',
                label: 'Столбцы',
                render: <BarChart values={thData.values} labels={thData.hours.map(String)} titles={thData.values.map((v, i) => `${thData.hours[i] ?? i}:00 — ${fmt.num(v)}`)} />,
              },
              {
                key: 'line',
                label: 'Линия',
                render: <LineChart values={thData.values} labels={thData.hours.map(String)} titles={thData.values.map((v, i) => `${thData.hours[i] ?? i}:00 — ${fmt.num(v)}`)} yMin={0} />,
              },
            ]}
          >
            {peakHourStr && <div className="mt-3 text-xs font-medium text-muted-foreground">{peakHourStr}</div>}
          </ChartSection>
        )}

        {inGroup('dynamics') && netGrowthPresent && (
          // Single-variant (no type switcher) so the diverging bars render THROUGH the widget's
          // fill context and fill the tile — as bare children they'd sit at the fixed ~120px and
          // leave dead space. The «прирост» total stays as the caption below.
          <ChartSection
            // The window lives in the CAPTION, not the title (аудит: «(30д)» в заголовке читался
            // как хардкод рядом с управляемыми окнами соседей). The body now follows the page top
            // bar (preset AND custom «Свой» range) via deriveNetGrowth — no longer a fixed 30-day
            // slice; existence is still gated by the whole payload so a narrow empty window
            // doesn't make the section vanish.
            // «подписчиков» обрезалось в карточке («Чистый прирост подпи…») и ясно из контекста;
            // id держит прежний ключ prefs-store, чтобы сохранённые настройки виджета не слетели.
            id="Чистый прирост подписчиков"
            title="Чистый прирост"
            drillTo="/metrics/subscribers"
            periodControl
            variants={netGrowthVariants}
          />
        )}

        {inGroup('dynamics') && netGrowthPresent && (
          <ChartSection title="Динамика оттока" periodControl variants={churnVariants}>
            <FollowerFlowTotal graphs={graphs} />
          </ChartSection>
        )}

        {/* Раньше оба графика жили в одной двойной секции — её ячейка была вдвое выше соседних и
            оставляла в сетке огромную пустую область. Теперь каждая секция — своя ячейка. Обе —
            пост-производные: считаются по постам выбранного окна. Раньше они игнорировали период
            вовсе и шли по всем постам. */}
        {inGroup('audience') && maxWdAvg > 0 && (
          <ChartSection title="По дням недели" periodControl variants={weekdayVariants}>
            <WeekdayBestDay full={full} />
          </ChartSection>
        )}

        {inGroup('audience') && maxWdAvg > 0 && (
          /* D6.3: секция — последняя в «Аудитории» и при нечётном числе плиток растягивается
             на обе колонки; 7 столбиков с кэпом 48px по центру full-width ряда = «острова в
             пустоте». max-w держит чарт компактным слева (в 1×-плитке кэп не срабатывает). */
          <ChartSection title="Количество постов" periodControl variants={postCountVariants} />
        )}
      </WidgetGroup>
    </div>
  );
}

function TgAnalyticsSkeletons({ showSummary }: { showSummary: boolean }) {
  // Mirror the real render — open KPI ledger + hairline chart sections — so nothing swaps on load.
  return (
    <div className="space-y-6">
      {showSummary && (
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-4 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i}>
              <Skeleton className="h-2.5 w-2/3" />
              <Skeleton className="mt-2 h-5 w-1/2" />
            </div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-3">
            <Skeleton className="h-3 w-1/4" />
            <Skeleton className="h-40 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
