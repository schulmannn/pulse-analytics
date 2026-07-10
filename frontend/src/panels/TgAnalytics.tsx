import { useMemo } from 'react';
import { useTgFull, useTgStats, useTgGraphs } from '@/api/queries';
import type { TgFull, TgGraphs, TgStats } from '@/api/schemas';
import { normalizeTgPosts } from '@/lib/posts';
import { compareDdMm } from '@/lib/dates';
import { fmt, ruAxisLabel, ruSeriesName, ddmmDay, pluralRu } from '@/lib/format';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { ChartCardBody, ChartSection } from '@/components/ChartWidget';
import { WidgetGroup } from '@/components/widgets/WidgetGroup';
import { breakdownVariants, seriesBarValuesVariant } from '@/components/widgets/variants';
import { pctDelta } from '@/lib/delta';
import { DivergingBars } from '@/components/DivergingBars';
import { EmptyState } from '@/components/EmptyState';
import { useWidgetPeriod } from '@/lib/period';
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

/** Rich-expand windowing for a graphs (daily-flow) series: the last `days` points (0 = «Всё»),
    with ms-timestamp labels + RU tooltips. A graphs point ≈ one day, so slicing by count windows
    by day; a shorter server series just returns all it has (honest — never fabricates points).
    Optional opts: drop today's partial point («Включая сегодня» off) and bucket the window by
    ISO week (Monday anchor) or calendar month — sums, since these are flow metrics. */
function windowGraphSeries(values: number[], xs: number[], days: number, unit: string, opts?: GraphSeriesOpts) {
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
  const n = days === 0 ? vals.length : Math.min(days, vals.length);
  let wValues = vals.slice(-n);
  let wxs = xss.slice(-n);
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
  // the comparison would be dishonest: «Всё» has no previous window, and a partial previous
  // window (fewer than n daily points before the visible slice) never fabricates one.
  const total = wValues.reduce((acc, v) => acc + v, 0);
  const prevSlice = days === 0 || vals.length < 2 * n ? null : vals.slice(-2 * n, -n);
  const prevTotal = prevSlice ? prevSlice.reduce((acc, v) => acc + v, 0) : null;
  return { values: wValues, labels, titles, total, prevTotal };
}

/**
 * All normalisation/aggregation for the TG analytics sections, extracted so the component
 * can memoize it — previously these ~180 lines re-ran on every render for all four tab
 * groups. Pure: depends only on the three query payloads + the period predicate.
 */
function deriveTgAnalytics(
  full: TgFull | undefined,
  cs: TgStats | undefined,
  graphs: TgGraphs | undefined,
  inRange: (dateISO: string | null | undefined) => boolean,
) {
  const vs = full?.views_summary;
  const posts = normalizeTgPosts(full?.posts ?? [], full?.channel ?? {}).filter((post) =>
    inRange(post.date),
  );

  const cur = (o: { current?: number | null } | null | undefined) =>
    o && o.current != null ? o.current : null;

  // 1) KPI
  const activeErvs = posts.map((p) => p.erv).filter((v): v is number => v !== null);
  const avgErv = activeErvs.length ? activeErvs.reduce((a, b) => a + b, 0) / activeErvs.length : null;
  const activeVirs = posts.map((p) => p.virality).filter((v): v is number => v !== null);
  const avgVir = activeVirs.length ? activeVirs.reduce((a, b) => a + b, 0) / activeVirs.length : null;
  const notif = cs?.enabled_notifications;
  const notifPct = notif?.total ? (Number(notif.part ?? 0) / Number(notif.total)) * 100 : null;

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

  // 3) Reactions by emoji
  const emojiMap: Record<string, number> = {};
  posts.forEach((p) => {
    p.reactionsDetail.forEach((rd) => {
      if (rd.emoji) emojiMap[rd.emoji] = (emojiMap[rd.emoji] ?? 0) + rd.count;
    });
  });
  const topEmojis = Object.entries(emojiMap)
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  // 4) Engagement composition
  const engagementComposition = [
    { label: 'Реакции', value: Number(vs?.total_reactions ?? 0), color: 'hsl(var(--chart-1))' },
    { label: 'Репосты', value: Number(vs?.total_forwards ?? 0), color: 'hsl(var(--chart-2))' },
    { label: 'Комментарии', value: Number(vs?.total_replies ?? 0), color: 'hsl(var(--chart-3))' },
  ].filter((item) => item.value > 0);

  // 5) Avg views by type
  const typeNames: Record<string, string> = {
    photo: 'Фото', video: 'Видео', poll: 'Опросы', document: 'Файлы',
    text: 'Текст', audio: 'Аудио', voice: 'Голос', link: 'Ссылки',
  };
  const rawViewsByType = vs?.avg_views_by_type;
  const viewsByType = rawViewsByType
    ? Object.entries(rawViewsByType)
        .map(([key, value]) => ({ label: typeNames[key] || key, value: Number(value) }))
        .filter((item) => item.value > 0)
        .sort((a, b) => b.value - a.value)
    : [];

  // 5b) Engagement quality by format — avg ERV per media type (which formats actually engage,
  // not just which get views). Computed from the in-range posts.
  const formatPerf = (() => {
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
      .map(([t, v]) => ({ label: typeNames[t] || t, avgErv: v.ervN ? v.ervSum / v.ervN : 0, n: v.n }))
      .filter((x) => x.n > 0 && x.avgErv > 0)
      .sort((a, b) => b.avgErv - a.avgErv);
  })();

  // 6) Views & reposts — two separate widgets (daily FLOWS, so zero-based bars are honest).
  // (The subscriber-LEVEL «Рост подписчиков» card lived here; removed as a duplicate — the level
  // trend is «История подписчиков» (full archive + rich explorer) and the daily net is «Чистый
  // прирост подписчиков» below, so a third level+delta card only repeated both.)
  const interGroup = graphs?.interactions;
  const interSeries = interGroup?.series ?? [];
  const viewSeries = interSeries.find((s) => /view|просмотр/i.test(s.name ?? '')) || interSeries[0];
  const shareSeries = interSeries.find((s) => /share|репост/i.test(s.name ?? '')) || interSeries[1];

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
  const joinedSeries = fSeries.find((s) => /join|подпис/i.test(s.name ?? '')) || fSeries[0];
  const leftSeries = fSeries.find((s) => /left|отпис/i.test(s.name ?? '')) || fSeries[1];

  let net30Values: number[] = [];
  let net30Titles: string[] = [];
  let netSummaryStr = '';
  let net30Total = 0;
  let net30Prev: number | null = null;
  let joinedTotal = 0;
  let leftTotal = 0;

  if (joinedSeries && leftSeries) {
    const mLen = Math.min(joinedSeries.values.length, leftSeries.values.length);
    const netArr: number[] = [];
    const fx = fGroup?.x ?? [];
    for (let i = 0; i < mLen; i++) {
      const jV = Number(joinedSeries.values[i] ?? 0);
      const lV = Number(leftSeries.values[i] ?? 0);
      joinedTotal += jV;
      leftTotal += lV;
      netArr.push(jV - lV);
    }
    net30Values = netArr.slice(-30);
    const fx30 = fx.slice(-30);
    net30Titles = net30Values.map((v, idx) => {
      const ts = fx30[idx];
      return `${ts ? formatMsDate(ts) : ''}: ${v >= 0 ? '+' : ''}${fmt.num(v)} за день`;
    });
    const netPeriod = joinedTotal - leftTotal;
    netSummaryStr = `${netPeriod >= 0 ? '+' : ''}${fmt.num(netPeriod)} за период`;
    // Steep headline for the net-growth card: this window's net + the previous 30-day window's
    // net (honest null when the series is shorter than two windows).
    net30Total = net30Values.reduce((acc, v) => acc + v, 0);
    net30Prev = netArr.length >= 60 ? netArr.slice(-60, -30).reduce((acc, v) => acc + v, 0) : null;
  }

  // 12) Weekday — filtered by the active window (previously iterated ALL fetched posts, ignoring
  // the period: a latent bug the per-widget model fixes — each weekday card honours its own window).
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
    vs, cur, avgErv, avgVir, notif, notifPct,
    last14Dates, vbdValues, vbdTitles, vbdPrev,
    topEmojis, engagementComposition, viewsByType, formatPerf,
    interGroup, viewSeries, shareSeries,
    vbsItems, nfsItems, langItems, sentItems,
    thData, hasHours, peakHourStr,
    net30Values, net30Titles, netSummaryStr, net30Total, net30Prev, joinedTotal, leftTotal,
    wdAvgValues, wdCountValues, maxWdAvg, bestWdLabel,
  };
}

/** All-data window predicate — the panel-level derive uses it so that (a) which sections EXIST
    is decided by the whole fetched payload (sections don't pop in/out as a card's window changes)
    and (b) graphs-driven series (period-agnostic anyway) render their full server window. */
const alwaysInRange = () => true;

// ── Focused per-widget derives ──────────────────────────────────────────────────────────────
// The four post-derived charts recompute their OWN series from the card's window (variants-fn form
// of ChartSection passes the widget's inRange). Focused helpers instead of re-running the whole
// deriveTgAnalytics pass — each touches only the ≤100 fetched posts it needs.

const TYPE_NAMES: Record<string, string> = {
  photo: 'Фото', video: 'Видео', poll: 'Опросы', document: 'Файлы',
  text: 'Текст', audio: 'Аудио', voice: 'Голос', link: 'Ссылки',
};

type InRange = (dateISO: string | null | undefined) => boolean;

/** «Реакции по эмодзи» — top-8 emoji reactions over the in-window posts. */
function deriveEmojis(full: TgFull | undefined, inRange: InRange) {
  const posts = normalizeTgPosts(full?.posts ?? [], full?.channel ?? {}).filter((p) => inRange(p.date));
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
function deriveFormatPerf(full: TgFull | undefined, inRange: InRange) {
  const posts = normalizeTgPosts(full?.posts ?? [], full?.channel ?? {}).filter((p) => inRange(p.date));
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

/** «лучший день» caption under «По дням недели» — reads the card's OWN window (useWidgetPeriod),
    so the best-day claim matches the bars shown, not the panel default. Rendered inside the
    ChartSection body → inside its WidgetPeriodProvider. */
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

/** `group` renders only that section family (the Analytics tabs); undefined = all sections. The KPI
    ledger always shows as the group header. */
export function TgAnalytics({ group }: { group?: TgAnalyticsGroup } = {}) {
  const inGroup = (g: TgAnalyticsGroup) => !group || group === g;
  // ONE wide fetch (limit 100 = server cap): every widget below filters this shared payload to its
  // own window. No global period any more — each ChartSection carries its own 7д/30д/90д/Всё pill.
  const { data: full, isPending: isFullPending } = useTgFull(0);
  const { data: cs, isPending: isStatsPending } = useTgStats();
  const { data: graphs, isPending: isGraphsPending } = useTgGraphs();

  // Panel-level derive over the WHOLE fetched payload (alwaysInRange): section-existence gates +
  // the KPI ledger snapshot + graphs-driven series. Post-derived CHART VALUES are re-derived
  // per-card inside TgWidgetBody from each card's own window.
  const derived = useMemo(() => deriveTgAnalytics(full, cs, graphs, alwaysInRange), [full, cs, graphs]);

  if (isFullPending || isStatsPending || isGraphsPending) {
    return <TgAnalyticsSkeletons />;
  }

  if (!full && !cs && !graphs) {
    return <EmptyState title="Данных аналитики пока нет." reason="Как только collector-агент пришлёт первый снимок, здесь появятся графики." />;
  }

  const {
    vs, cur, avgErv, avgVir, notif, notifPct,
    last14Dates, vbdValues, vbdTitles, vbdPrev,
    topEmojis, engagementComposition, viewsByType, formatPerf,
    interGroup, viewSeries, shareSeries,
    vbsItems, nfsItems, langItems, sentItems,
    thData, hasHours, peakHourStr,
    net30Values, net30Titles, net30Total, net30Prev, joinedTotal, leftTotal,
    maxWdAvg,
  } = derived;
  const wdLabels = WD_LABELS;

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
        <ChartSection strip id="tg-derived-kpis" title="Сводка показателей" defaultSize="full" noExpand>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-4 sm:grid-cols-3 lg:grid-cols-6">
            <div>
              <div className="text-2xs tracking-wide text-muted-foreground">Просмотров / пост</div>
              <div className="mt-1.5 text-2xl font-medium tabular-nums tracking-tight">{fmt.kpi(cur(cs?.views_per_post) ?? vs?.avg_views ?? 0)}</div>
              {vs?.posts_analyzed ? <div className="mt-1 truncate text-2xs text-muted-foreground">по {vs.posts_analyzed} постам</div> : null}
            </div>
            <div>
              <div className="text-2xs tracking-wide text-muted-foreground">Ср. ERV</div>
              <div className="mt-1.5 text-2xl font-medium tabular-nums tracking-tight">{avgErv != null ? `${avgErv.toFixed(1)}%` : '—'}</div>
              <div className="mt-1 truncate text-2xs text-muted-foreground">вовлечённость на просмотр</div>
            </div>
            <div>
              <div className="text-2xs tracking-wide text-muted-foreground">Виральность</div>
              <div className="mt-1.5 text-2xl font-medium tabular-nums tracking-tight">{avgVir != null ? `${avgVir.toFixed(1)}%` : '—'}</div>
              <div className="mt-1 truncate text-2xs text-muted-foreground">репосты / просмотры</div>
            </div>
            <div>
              <div className="text-2xs tracking-wide text-muted-foreground">Репостов / пост</div>
              <div className="mt-1.5 text-2xl font-medium tabular-nums tracking-tight">{cur(cs?.shares_per_post) != null ? fmt.kpi(cur(cs?.shares_per_post)!) : '—'}</div>
              {vs?.total_forwards ? <div className="mt-1 truncate text-2xs text-muted-foreground">{fmt.short(vs.total_forwards)} всего</div> : null}
            </div>
            <div>
              <div className="text-2xs tracking-wide text-muted-foreground">Реакций / пост</div>
              <div className="mt-1.5 text-2xl font-medium tabular-nums tracking-tight">{cur(cs?.reactions_per_post) != null ? fmt.kpi(cur(cs?.reactions_per_post)!) : '—'}</div>
              {vs?.total_reactions ? <div className="mt-1 truncate text-2xs text-muted-foreground">{fmt.short(vs.total_reactions)} всего</div> : null}
            </div>
            <div>
              <div className="text-2xs tracking-wide text-muted-foreground">Уведомления вкл.</div>
              <div className="mt-1.5 text-2xl font-medium tabular-nums tracking-tight">{notifPct != null ? `${notifPct.toFixed(1)}%` : '—'}</div>
              {notif ? <div className="mt-1 truncate text-2xs text-muted-foreground">{fmt.short(notif.part ?? 0)} из {fmt.short(notif.total ?? 0)}</div> : null}
            </div>
          </div>
        </ChartSection>
        {/* Дубль-развязка (аудит 5.1): «Просмотры по дням» (views_summary, фикс-14д + ghost) и
            «Просмотры» (graphs-серия, rich expand/grain) показывали одни и те же дневные просмотры
            на каналах с broadcast-статистикой. Теперь эта карточка — ЧЕСТНЫЙ FALLBACK только для
            каналов без graphs (мелкие/QR: views_summary есть, статистики нет); на больших остаётся
            один rich «Просмотры», а сравнение периодов живёт на метрик-странице просмотров. */}
        {inGroup('dynamics') && !viewSeries && last14Dates.length >= 2 && (
          <ChartSection
            title="Просмотры по дням"
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

        {/* Пост-производный: топ эмодзи считаются по постам ОКНА виджета (variants-fn form). */}
        {inGroup('content') && topEmojis.length > 0 && (
          <ChartSection
            title="Реакции по эмодзи"
            periodControl
            variants={(period) =>
              breakdownVariants(
                deriveEmojis(full, period.inRange).map((e) => ({ label: e.label, value: e.value, display: fmt.num(e.value) })),
              )
            }
          />
        )}

        {/* Серверная сводка (vs.total_*): период-агностично — та же цифра в любом окне. */}
        {inGroup('content') && engagementComposition.length > 0 && (
          <ChartSection title="Состав вовлечённости" variants={breakdownVariants(engagementComposition.map((c) => ({ label: c.label, value: c.value, display: fmt.num(c.value), color: c.color })))} />
        )}

        {/* Серверная сводка (vs.avg_views_by_type): период-агностично. */}
        {inGroup('content') && viewsByType.length > 0 && (
          <ChartSection title="Ср. охват по типу" variants={breakdownVariants(viewsByType.map((t) => ({ label: t.label, value: t.value, display: fmt.num(t.value) })))} />
        )}

        {/* Пост-производный: средний ERV по формату — по постам окна виджета. */}
        {inGroup('content') && formatPerf.length > 0 && (
          <ChartSection
            title="Вовлечённость по формату"
            periodControl
            variants={(period) =>
              breakdownVariants(
                deriveFormatPerf(full, period.inRange).map((f) => ({ label: f.label, value: f.avgErv, display: `${f.avgErv.toFixed(1)}% ERV · ${f.n} ${pluralRu(f.n, ['пост', 'поста', 'постов'])}` })),
              )
            }
          />
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
            drillTo="/metrics/views"
            // Rich explorer (steep): «Развернуть» grows 1М/3М/6М/Всё pills, a line↔bar toggle and a
            // Мин/Макс/Среднее/Сумма strip — windowing the full graphs series the inline card can't.
            expand={{
              grainable: true,
              renderExpanded: (days, grain) => {
                const w = windowGraphSeries(viewSeries.values, interGroup.x, days, 'просмотров', { grain });
                return <LineChart values={w.values} labels={w.labels} titles={w.titles} markAnomalies markExtremes emphasizeLastLabel />;
              },
              renderExpandedBar: (days, grain) => {
                const w = windowGraphSeries(viewSeries.values, interGroup.x, days, 'просмотров', { grain });
                return <BarChart values={w.values} labels={w.labels} titles={w.titles} />;
              },
              statsFor: (days, grain) => windowGraphSeries(viewSeries.values, interGroup.x, days, 'просмотров', { grain }).values,
            }}
            seriesOptions
            periodControl
            variants={(period, series) => {
              // Windowed by the WIDGET period (follows the page by default) through the
              // edit-dialog display opts; the steep body adds the window total + the mandatory
              // comparison vs the previous window (honest null on «Всё»).
              const w = windowGraphSeries(viewSeries.values, interGroup.x, period.days, 'просмотров', series);
              const delta = w.prevTotal != null && w.prevTotal > 0 ? pctDelta(w.total, w.prevTotal) : null;
              const caption = delta ? 'к пред. периоду' : period.days === 0 ? 'за всё время' : undefined;
              return [
                {
                  key: 'line',
                  label: 'Линия',
                  render: (
                    <ChartCardBody value={fmt.kpi(w.total)} delta={delta} caption={caption}>
                      <LineChart values={w.values} labels={w.labels} titles={w.titles} markAnomalies emphasizeLastLabel />
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
            }}
          />
        )}
        {inGroup('dynamics') && interGroup && shareSeries && (
          <ChartSection
            id="tg-shares-graph"
            title={ruSeriesName(shareSeries.name) || 'Репосты'}
            drillTo="/metrics/forwards"
            expand={{
              grainable: true,
              renderExpanded: (days, grain) => {
                const w = windowGraphSeries(shareSeries.values, interGroup.x, days, 'репостов', { grain });
                return <LineChart values={w.values} labels={w.labels} titles={w.titles} markAnomalies markExtremes emphasizeLastLabel />;
              },
              renderExpandedBar: (days, grain) => {
                const w = windowGraphSeries(shareSeries.values, interGroup.x, days, 'репостов', { grain });
                return <BarChart values={w.values} labels={w.labels} titles={w.titles} />;
              },
              statsFor: (days, grain) => windowGraphSeries(shareSeries.values, interGroup.x, days, 'репостов', { grain }).values,
            }}
            seriesOptions
            periodControl
            variants={(period, series) => {
              const w = windowGraphSeries(shareSeries.values, interGroup.x, period.days, 'репостов', series);
              const delta = w.prevTotal != null && w.prevTotal > 0 ? pctDelta(w.total, w.prevTotal) : null;
              const caption = delta ? 'к пред. периоду' : period.days === 0 ? 'за всё время' : undefined;
              return [
                {
                  key: 'line',
                  label: 'Линия',
                  render: (
                    <ChartCardBody value={fmt.kpi(w.total)} delta={delta} caption={caption}>
                      <LineChart values={w.values} labels={w.labels} titles={w.titles} emphasizeLastLabel />
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
            }}
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

        {inGroup('dynamics') && net30Values.length > 0 && (
          // Single-variant (no type switcher) so the diverging bars render THROUGH the widget's
          // fill context and fill the tile — as bare children they'd sit at the fixed ~120px and
          // leave dead space. The «прирост» total stays as the caption below.
          <ChartSection
            // The window lives in the CAPTION, not the title (аудит: «(30д)» в заголовке читался
            // как хардкод рядом с управляемыми окнами соседей). This card's window IS fixed —
            // net30Values derives panel-level from the last 30 days; wiring it to a per-widget
            // period is the unified-feed follow-up.
            title="Чистый прирост подписчиков"
            drillTo="/metrics/subscribers"
            variants={[
              {
                key: 'bar',
                label: 'Столбцы',
                render: (
                  <ChartCardBody
                    value={`${net30Total >= 0 ? '+' : '−'}${fmt.kpi(Math.abs(net30Total))}`}
                    delta={net30Prev != null && net30Prev > 0 && net30Total >= 0 ? pctDelta(net30Total, net30Prev) : null}
                    caption="окно 30 дней"
                  >
                    <DivergingBars values={net30Values} titles={net30Titles} />
                  </ChartCardBody>
                ),
              },
            ]}
          />
        )}

        {inGroup('dynamics') && (joinedTotal > 0 || leftTotal > 0) && (
          <ChartSection
            title="Динамика оттока"
            variants={breakdownVariants(
              [
                { label: 'Подписалось', value: joinedTotal, display: fmt.num(joinedTotal), color: 'hsl(var(--brand-verdant))' },
                { label: 'Отписалось', value: leftTotal, display: fmt.num(leftTotal), color: 'hsl(var(--brand-ember))' },
              ].filter((i) => i.value > 0),
            )}
          />
        )}

        {/* Раньше оба графика жили в одной двойной секции — её ячейка была вдвое выше соседних и
            оставляла в сетке огромную пустую область. Теперь каждая секция — своя ячейка. Обе —
            пост-производные: считаются по постам ОКНА виджета (variants-fn + per-widget caption).
            Раньше они игнорировали период вовсе (шли по ВСЕМ постам) — per-widget модель это чинит. */}
        {inGroup('audience') && maxWdAvg > 0 && (
          <ChartSection
            title="По дням недели"
            periodControl
            variants={(period) => {
              const { wdAvgValues } = deriveWeekday(full, period.inRange);
              return [
                {
                  key: 'bar',
                  label: 'Столбцы',
                  render: (
                    <div>
                      <div className="mb-2 text-2xs tracking-wide text-muted-foreground">Ср. просмотры</div>
                      <BarChart values={wdAvgValues} labels={wdLabels} titles={wdAvgValues.map((v, i) => `${wdLabels[i]}: ${fmt.num(v)} ср. просмотров`)} />
                    </div>
                  ),
                },
                {
                  key: 'line',
                  label: 'Линия',
                  render: <LineChart values={wdAvgValues} labels={wdLabels} titles={wdAvgValues.map((v, i) => `${wdLabels[i]}: ${fmt.num(v)} ср. просмотров`)} yMin={0} />,
                },
              ];
            }}
          >
            <WeekdayBestDay full={full} />
          </ChartSection>
        )}

        {inGroup('audience') && maxWdAvg > 0 && (
          /* D6.3: секция — последняя в «Аудитории» и при нечётном числе плиток растягивается
             на обе колонки; 7 столбиков с кэпом 48px по центру full-width ряда = «острова в
             пустоте». max-w держит чарт компактным слева (в 1×-плитке кэп не срабатывает). */
          <ChartSection
            title="Количество постов"
            periodControl
            variants={(period) => {
              const { wdCountValues } = deriveWeekday(full, period.inRange);
              return [
                {
                  key: 'bar',
                  label: 'Столбцы',
                  render: (
                    <div className="max-w-[560px]">
                      <BarChart values={wdCountValues} labels={wdLabels} titles={wdCountValues.map((v, i) => `${wdLabels[i]}: ${fmt.num(v)} постов`)} />
                    </div>
                  ),
                },
                {
                  key: 'line',
                  label: 'Линия',
                  render: (
                    <div className="max-w-[560px]">
                      <LineChart values={wdCountValues} labels={wdLabels} titles={wdCountValues.map((v, i) => `${wdLabels[i]}: ${fmt.num(v)} постов`)} yMin={0} />
                    </div>
                  ),
                },
              ];
            }}
          />
        )}
      </WidgetGroup>
    </div>
  );
}

function TgAnalyticsSkeletons() {
  // Mirror the real render — open KPI ledger + hairline chart sections — so nothing swaps on load.
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-4 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i}>
            <Skeleton className="h-2.5 w-2/3" />
            <Skeleton className="mt-2 h-5 w-1/2" />
          </div>
        ))}
      </div>
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
