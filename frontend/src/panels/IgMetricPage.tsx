import { Suspense, lazy, useEffect, useState } from 'react';
import { InspectorHandle } from '@/components/InspectorHandle';
import { Link, useParams } from 'react-router-dom';
import { isMsMetricKey } from '@/panels/sklad/msMetricKeys';
import { isYmMetricKey } from '@/panels/metrika/ymMetricKeys';
import { isTgExtraMetricKey } from '@/panels/tgMetricKeys';
import { isMentionsMetricKey } from '@/panels/mentions/mentionsMetricKeys';
import { useIgData } from '@/lib/useIgData';
import type { IgData } from '@/lib/useIgData';
import { usePeriod, type PeriodDays } from '@/lib/period';
import {
  pairDelta,
  igAgeItems,
  igGenderItems,
  igCountryItems,
  igCityItems,
  igFormatEngagementItems,
  igReelsWatchTime,
  igStoryNavItems,
} from '@/lib/igMetrics';
import type { WindowPair, IgBreakdownItem } from '@/lib/igMetrics';
import { pctDelta } from '@/lib/delta';
import { fmt } from '@/lib/format';
import { windowIgSeries, ChartSection as RailSection, KpiCard } from '@/components/instagram/shared';
import { BestTimeHeatmap } from '@/components/instagram/audience';
import { ChartSection } from '@/components/ChartWidget';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { Breakdown } from '@/components/Breakdown';
import { ChartExpandedContext, ExpandedChartHeightContext } from '@/components/ExpandableChart';
import { DeltaPill } from '@/components/DeltaPill';
import { SegmentedControl } from '@/components/SegmentedControl';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';
import { PinnedDayPanel } from '@/components/PinnedDayPanel';
import { MetricPage, SegSelect } from '@/panels/MetricPage';
import { isIgChartMetricKey } from '@/panels/igMetricKeys';
import { useIgScopedPosts } from '@/panels/instagram/igContentScope';
import { useExplorerChartHeight } from '@/lib/useExplorerChartHeight';
import { lazyWithReload } from '@/lib/lazyWithReload';
import type { ReactNode } from 'react';

/**
 * Instagram metric pages — the drill target the unified chart contract points IG cards at
 * (/metrics/ig-*), mirroring the TG explorer's steep layout. HONESTY over parity with the TG
 * page: Instagram only returns TWO genuine daily series (reach, daily follows) — those get the
 * full chart explorer; every other metric arrives as a PERIOD AGGREGATE, so its page compares
 * periods instead of fabricating a daily line. No post-level breakdown either (the API gives
 * fixed demographic dimensions, not per-post fields), so the rail is comparison + about only.
 */

interface IgDailyDef {
  term: string;
  /** Genitive for tooltips («… охвата»). */
  genitive: string;
  seriesKey: 'reach' | 'follower' | 'views' | 'ti' | 'likes' | 'saves';
  formula: string;
  included: string;
  source: string;
  /** PROMOTED metric (all the additive engagement series): its daily chart is real ONLY once the
      ig_daily archive has accumulated the series. Until then the page falls back to the aggregate
      comparison (via AGG_DEFS) so we never draw a 2-point synthetic line. reach/follows have no gate. */
  promotedGate?: 'viewsHasDaily' | 'tiHasDaily' | 'likesHasDaily' | 'savesHasDaily';
}

const DAILY_DEFS: Record<string, IgDailyDef> = {
  'ig-reach': {
    term: 'Охват',
    genitive: 'охвата',
    seriesKey: 'reach',
    formula: 'Дневной охват — уникальные аккаунты, видевшие контент в этот день. Заголовок — сумма дневных охватов выбранного окна.',
    included:
      'Сумма по дням выше «охвата периода» на Обзоре: за период Instagram дедуплицирует повторных зрителей, по дням — нет. Обе цифры честные, но отвечают на разные вопросы.',
    source: 'Instagram insights (reach) + дневной архив ig_daily.',
  },
  'ig-follows': {
    term: 'Подписки',
    genitive: 'подписок',
    seriesKey: 'follower',
    formula:
      'График «Подписчики» — реальный уровень базы по дням (как у Telegram); заголовок — текущее количество и изменение за окно. «Подписки по дням» ниже — новые подписки за каждый день.',
    included:
      'Уровень собирается из ежедневных фиксаций реального количества подписчиков; дни до начала фиксаций достроены назад от живого значения по чистому движению (подписки − отписки). «Подписки по дням» — только валовые подписки: отписки Instagram по дням не отдаёт.',
    source: 'Профиль Instagram (followers_count, ежедневная фиксация в ig_daily) + insights (follows).',
  },
  'ig-views': {
    term: 'Просмотры',
    genitive: 'просмотров',
    seriesKey: 'views',
    formula: 'Просмотры контента по дням; заголовок — сумма за выбранное окно.',
    included:
      'Дневной ряд копится в архиве ig_daily (живой API отдаёт только итог за период). Просмотры аддитивны — сумма по дням равна периоду.',
    source: 'Instagram insights (views) + дневной архив ig_daily.',
    promotedGate: 'viewsHasDaily',
  },
  'ig-interactions': {
    term: 'Взаимодействия',
    genitive: 'взаимодействий',
    seriesKey: 'ti',
    formula: 'Лайки + комментарии + сохранения + репосты по дням; заголовок — сумма за окно.',
    included:
      'Дневной ряд копится в архиве ig_daily (живой API отдаёт только итог за период). Взаимодействия аддитивны — сумма по дням равна периоду.',
    source: 'Instagram insights (total_interactions) + дневной архив ig_daily.',
    promotedGate: 'tiHasDaily',
  },
  'ig-likes': {
    term: 'Лайки',
    genitive: 'лайков',
    seriesKey: 'likes',
    formula: 'Лайки на контент по дням; заголовок — сумма за выбранное окно.',
    included:
      'Дневной ряд копится в архиве ig_daily (живой API отдаёт только итог за период). Лайки аддитивны — сумма по дням равна периоду.',
    source: 'Instagram insights (likes) + дневной архив ig_daily.',
    promotedGate: 'likesHasDaily',
  },
  'ig-saves': {
    term: 'Сохранения',
    genitive: 'сохранений',
    seriesKey: 'saves',
    formula: 'Сохранения контента по дням; заголовок — сумма за выбранное окно.',
    included:
      'Дневной ряд копится в архиве ig_daily (живой API отдаёт только итог за период). Сохранения аддитивны — сумма по дням равна периоду.',
    source: 'Instagram insights (saves) + дневной архив ig_daily.',
    promotedGate: 'savesHasDaily',
  },
};

interface IgAggDef {
  term: string;
  pairKey: 'views' | 'ti' | 'likes' | 'saves';
  formula: string;
  source: string;
}

const AGG_DEFS: Record<string, IgAggDef> = {
  'ig-views': {
    term: 'Просмотры',
    pairKey: 'views',
    formula: 'Просмотры контента за выбранный период.',
    source: 'Instagram insights (views) — агрегат за период; дневной серии API не отдаёт.',
  },
  'ig-interactions': {
    term: 'Взаимодействия',
    pairKey: 'ti',
    formula: 'Лайки + комментарии + сохранения + репосты за период.',
    source: 'Instagram insights (total_interactions) — агрегат за период; дневной серии API не отдаёт.',
  },
  'ig-likes': {
    term: 'Лайки',
    pairKey: 'likes',
    formula: 'Лайки на контент за выбранный период.',
    source: 'Instagram insights (likes) — агрегат за период; дневной серии API не отдаёт.',
  },
  'ig-saves': {
    term: 'Сохранения',
    pairKey: 'saves',
    formula: 'Сохранения контента за выбранный период.',
    source: 'Instagram insights (saves) — агрегат за период; дневной серии API не отдаёт.',
  },
};

/** ER — the one DERIVED IG metric page: a ratio of two period aggregates, so it gets the
    aggregate (period-vs-period) template plus its numerator/denominator decomposition. */
const ER_DEF = {
  term: 'Вовлечённость (ER)',
  formula: 'Взаимодействия ÷ охват × 100% за выбранный период.',
  source: 'Производная от Instagram insights (total_interactions, reach) — агрегаты за период.',
};

export function isIgMetricKey(raw: string | undefined): boolean {
  return raw != null && (raw in DAILY_DEFS || raw in AGG_DEFS || raw === 'ig-er' || isIgChartMetricKey(raw));
}

/** МойСклад metric/report pages live in their own lazy chunk: a TG/IG user opening a TG/IG metric
    page must never download the MS panel bundle (it's only pulled when an `ms-*` key opens here). */
const MsMetricPageLazy = lazy(lazyWithReload(() => import('@/panels/sklad/MsMetricPage').then((m) => ({ default: m.MsMetricPage }))));

/** «Яндекс.Метрика» metric/report pages share МойСклад's lazy-chunk discipline: a TG/IG viewer who
    opens a TG/IG metric page must never download the YM panel bundle (it is only pulled when a
    `ym-*` key opens here). */
const YmMetricPageLazy = lazy(lazyWithReload(() => import('@/panels/metrika/YmMetricPage').then((m) => ({ default: m.YmMetricPage }))));

/** Telegram «extra chart» pages (activity heatmap / views velocity) share the lazy-chunk discipline:
    they are only pulled when a `tg-*` extra key opens, never for a numeric TG drill (views/er/…). */
const TgMetricPageLazy = lazy(lazyWithReload(() => import('@/panels/TgMetricPage').then((m) => ({ default: m.TgMetricPage }))));

/** Mentions chart pages live in their own lazy chunk and reuse the same metric-route shell. */
const MentionsMetricPageLazy = lazy(lazyWithReload(() => import('@/panels/mentions/MentionsMetricPage').then((m) => ({ default: m.MentionsMetricPage }))));

/** /metrics/:key dispatcher: numeric TG keys → the steep explorer, tg-* extra keys → the TG chart
    pages, mentions-* keys → the Mentions pages, ig-* keys → the IG page, ms-* keys → the
    МойСклад page, ym-* keys → the Метрика page.
    MetricPage itself redirects unknown keys home, so the fallthrough stays safe. YM/MS/IG/tg-extra
    and Mentions are each matched before the numeric-TG fallthrough so their lazy branch wins. */
export function MetricRoute() {
  const { key } = useParams<{ key: string }>();
  if (isYmMetricKey(key)) {
    return (
      <Suspense fallback={<MetricRouteFallback />}>
        <YmMetricPageLazy metricKey={key} />
      </Suspense>
    );
  }
  if (isTgExtraMetricKey(key)) {
    return (
      <Suspense fallback={<MetricRouteFallback />}>
        <TgMetricPageLazy metricKey={key} />
      </Suspense>
    );
  }
  if (isMentionsMetricKey(key)) {
    return (
      <Suspense fallback={<MetricRouteFallback />}>
        <MentionsMetricPageLazy metricKey={key} />
      </Suspense>
    );
  }
  if (isMsMetricKey(key)) {
    return (
      <Suspense fallback={<MetricRouteFallback />}>
        <MsMetricPageLazy metricKey={key} />
      </Suspense>
    );
  }
  if (isIgMetricKey(key)) return <IgMetricPage metricKey={key!} />;
  return <MetricPage />;
}

/** Layout-matching scaffold for the lazy MS page (breadcrumb + hero + two-column shell). */
function MetricRouteFallback() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-8 w-48" />
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

const WINDOW_PILLS = [
  { days: 7, label: '7д' },
  { days: 30, label: '30д' },
  { days: 90, label: '90д' },
  { days: 0, label: 'Всё' },
];

/** Тайм-бар окна — presets only. v2: тайм-бар принадлежит графику — рендерится одной строкой
    сразу под графиковым блоком своего варианта, НЕ sticky-панелью у нижнего края экрана
    (плавающая панель у края — тот же паттерн, что уже признавался багом: #109, дизайн-проход №3).
    The daily explorer feeds it a page-local window; the aggregate/ER pages wire it to the GLOBAL
    period (their windows live in useIgData), so every /metrics/ig-* page carries its own control —
    the feed header stopped being the only steering wheel when the feeds moved to the page-period
    system.
    `allowAll` = false на агрегатных/ER-страницах: живые insights не отдают «всё время», чип «Всё»
    молча показывал 90д — окно, которое страница не может исполнить, не предлагаем. */
function WindowBar({ value, onChange, allowAll = true }: { value: number; onChange: (days: PeriodDays) => void; allowAll?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2.5 print:hidden">
      <span className="text-xs font-medium text-muted-foreground">Окно</span>
      <span className="flex-1" />
      {/* Presets on the shared sliding-glider primitive. */}
      <SegmentedControl
        ariaLabel="Окно"
        value={String(value)}
        onChange={(days) => onChange(Number(days) as PeriodDays)}
        options={WINDOW_PILLS.filter((chip) => allowAll || chip.days !== 0).map((chip) => ({
          value: String(chip.days),
          content: chip.label,
        }))}
      />
    </div>
  );
}

export function IgMetricPage({ metricKey }: { metricKey: string }) {
  const ig = useIgData();
  const chartH = useExplorerChartHeight();
  // Page-local window for the daily explorer (the aggregate pages follow the GLOBAL IG period —
  // aggregates only exist per insights window, so a local window would have nothing to slice).
  const [days, setDays] = useState(30);
  const [kind, setKind] = useState<'line' | 'bar'>('line');
  const [cmp, setCmp] = useState<'off' | 'prev' | 'year'>('prev');
  // Pinned chart point — see MetricPage: any change of what the chart shows un-pins.
  const [pinned, setPinned] = useState<number | null>(null);
  // Отдельный пин для графика уровня «Подписчики» (ig-follows): у него свои индексы окна,
  // делить состояние с «Подписками по дням» нельзя (дизайн-проход №3: точки-приглашения
  // на уровне были нарисованы, но интерактивно мертвы).
  const [pinnedLvl, setPinnedLvl] = useState<number | null>(null);
  useEffect(() => {
    setPinned(null);
    setPinnedLvl(null);
  }, [metricKey, days, kind, cmp]);

  if (ig.loading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-8 w-48" />
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
  if (ig.error) {
    return (
      <ErrorState
        title="Не удалось загрузить данные Instagram"
        reason="Instagram API недоступен"
        onRetry={() => {
          void ig.queries.profile.refetch();
          void ig.queries.insights.refetch();
        }}
      />
    );
  }

  const handle = ig.profile?.username ? `@${ig.profile.username}` : null;
  // Chart cards (demographics / heatmap / format engagement / Reels / story navigation) migrated off
  // the generic ?detail= overlay. They reuse the already-fetched `ig` bundle (loading/error above are
  // shared) and each renders a truthful full page — never a fabricated daily series or comparison.
  if (isIgChartMetricKey(metricKey)) {
    return <IgChartMetricPage metricKey={metricKey} ig={ig} handle={handle} />;
  }
  if (metricKey === 'ig-er') {
    return (
      <IgErPage
        erReach={ig.erReach}
        erReachPrev={ig.erReachPrev}
        interactions={ig.pairs.ti}
        reach={ig.pairs.reach}
        windowDays={ig.window.days}
        handle={handle}
      />
    );
  }
  const daily = DAILY_DEFS[metricKey];
  // A promoted metric (views / взаимодействия) shows its daily chart ONLY once the ig_daily archive
  // carries the series; until then it degrades to the period-comparison page (never a synthetic
  // 2-point line). reach/follows have no gate — their daily series is genuine from day one.
  const gatedToAgg = daily?.promotedGate && !ig[daily.promotedGate];
  if (!daily || gatedToAgg) {
    return <IgAggregatePage def={AGG_DEFS[metricKey]} pair={ig.pairs[AGG_DEFS[metricKey].pairKey]} windowDays={ig.window.days} handle={handle} />;
  }

  // ── Daily explorer (reach / follows / promoted views·взаимодействия) ─────────────────────
  const seriesFull = ig.series[daily.seriesKey].filter((p) => p.day !== 'total');
  const win = windowIgSeries(seriesFull, days, daily.genitive);
  const n = win.values.length;
  const winPoints = seriesFull.slice(-n);
  // Comparison baseline. «Пред. период» — the same-length slice right BEFORE the window;
  // «Год назад» — the SAME CALENDAR DATES shifted a year back (by date, not index — the archive
  // may have gaps). Either is offered only when the archive fully covers it: a partial baseline
  // would understate the past and fake growth.
  let ghostVals: number[] = [];
  if (cmp === 'prev' && days > 0 && seriesFull.length >= 2 * n) {
    ghostVals = seriesFull.slice(-(2 * n), -n).map((p) => p.value);
  } else if (cmp === 'year' && days > 0) {
    const byDay = new Map(seriesFull.map((p) => [p.day, p.value]));
    const shifted = winPoints.map((p) => byDay.get(shiftYearBack(p.day)));
    if (shifted.every((v): v is number => v != null)) ghostVals = shifted;
  }
  const ghostOk = cmp !== 'off' && days > 0 && n > 1 && ghostVals.length === n;
  const cmpLabel = cmp === 'year' ? 'Год назад' : 'Пред. период';

  // Pinned point: winPoints carries the calendar day per index, so the day (and its posts —
  // IG posts have timestamps) resolves exactly, at any window.
  const pinnedValid = pinned != null && pinned >= 0 && pinned < n ? pinned : null;
  const pinnedDay = pinnedValid != null ? winPoints[pinnedValid]?.day : null;
  const pinnedPosts = pinnedDay
    ? ig.posts
        .filter((p) => p.timestamp && igDayKey(p.timestamp) === pinnedDay)
        .sort((a, b) => Number(b.reach ?? b.views ?? 0) - Number(a.reach ?? a.views ?? 0))
        .slice(0, 5)
    : [];
  const pinnedDiff = pinnedValid != null && pinnedValid > 0 ? win.values[pinnedValid] - win.values[pinnedValid - 1] : null;

  // ── «Подписчики» (только ig-follows): абсолютный уровень базы, как ТГ ────────────────────
  // Реальные дневные якоря followers_total + реконструкция от живого значения (см.
  // followerLevelSeries). Гейт ≥2 точек: без уровня страница остаётся прежней (сумма подписок).
  const levelFull = metricKey === 'ig-follows' ? ig.series.followerLevel : [];
  const lvl = levelFull.length > 1 ? windowIgSeries(levelFull, days, 'подписчиков') : null;
  const lvlNow = lvl && lvl.values.length > 1 ? lvl.values[lvl.values.length - 1]! : null;
  const lvlStart = lvl && lvl.values.length > 1 ? lvl.values[0]! : null;
  const lvlDiff = lvlNow != null && lvlStart != null ? lvlNow - lvlStart : null;
  const lvlTrend = lvlNow != null && lvlStart != null && lvlStart > 0 ? pctDelta(lvlNow, lvlStart) : null;

  const sumCur = win.values.reduce((s, v) => s + v, 0);
  const sumPrev = ghostOk ? ghostVals.reduce((s, v) => s + v, 0) : null;
  const trend = sumPrev != null ? pctDelta(sumCur, sumPrev) : null;
  const compareDelta = sumPrev != null && sumPrev > 0 ? ((sumCur - sumPrev) / sumPrev) * 100 : null;
  const periodLabel = days === 0 ? 'всё время' : `${days} дн.`;
  const stats =
    n > 0
      ? [
          { label: 'Мин', value: fmt.kpi(Math.min(...win.values)) },
          { label: 'Макс', value: fmt.kpi(Math.max(...win.values)) },
          { label: 'Среднее', value: fmt.kpi(sumCur / n) },
          { label: 'Сумма', value: fmt.kpi(sumCur) },
        ]
      : [];

  return (
    <div className="space-y-5">
      <Link to="/instagram" className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
        <span aria-hidden="true">←</span> Instagram
      </Link>

      {/* Тихая шапка v2: страница ведёт ИМЕНЕМ метрики, итог окна живёт в «Сравнении» справа
          (hero в шапке его дублировал), окно — в тайм-баре под графиком. На <lg rail уезжает под
          график, поэтому компактный итог остаётся в шапке только там. Для ig-follows при живом
          уровне страница ведёт «Подписчиками» (текущая база, как ТГ), а не суммой подписок. */}
      {lvlNow != null ? (
        <div>
          <h1 className="text-2xl font-medium tracking-tight text-foreground">Подписчики</h1>
          <div className="mt-1 text-xs tracking-wide text-muted-foreground">{handle ? `Instagram ${handle}` : 'Instagram'}</div>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 lg:hidden">
            <span className="text-3xl font-medium leading-none tabular-nums tracking-tight">{fmt.kpi(lvlNow)}</span>
            <DeltaPill delta={lvlTrend} />
            <span className="text-xs tracking-wide text-muted-foreground">{periodLabel}</span>
          </div>
          <div className="mt-1.5 text-xs text-muted-foreground">
            {lvlDiff != null && lvlDiff !== 0 ? (
              <>
                изменение за окно:{' '}
                <span className={lvlDiff > 0 ? 'text-verdant' : 'text-ember'}>
                  {lvlDiff > 0 ? '+' : '−'}
                  {fmt.num(Math.abs(lvlDiff))}
                </span>
              </>
            ) : (
              'база без изменений за окно'
            )}
          </div>
        </div>
      ) : (
        <div>
          <h1 className="text-2xl font-medium tracking-tight text-foreground">{daily.term}</h1>
          <div className="mt-1 text-xs tracking-wide text-muted-foreground">{handle ? `Instagram ${handle}` : 'Instagram'}</div>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 lg:hidden">
            <span className="text-3xl font-medium leading-none tabular-nums tracking-tight">{fmt.kpi(sumCur)}</span>
            <DeltaPill delta={trend} />
            <span className="text-xs tracking-wide text-muted-foreground">{periodLabel}</span>
          </div>
          <div className="mt-1.5 text-xs text-muted-foreground">сумма по дням за окно</div>
        </div>
      )}

      <div className="relative grid grid-cols-1 gap-6 xl:gap-8 lg:grid-cols-[minmax(0,1fr)_var(--inspector-w,300px)]">
        <InspectorHandle />
        <div className="min-w-0 space-y-6">
          {lvl != null && (
            <>
              <ChartSection id="metric-ig-followers-level" title="Подписчики" defaultSize="full" noExpand>
                <ChartExpandedContext.Provider value={true}>
                  <LineChart
                    values={lvl.values}
                    labels={lvl.labels}
                    titles={lvl.titles}
                    height={chartH}
                    markExtremes
                    showPoints={lvl.values.length <= 45}
                    legendToggle={false}
                    onPointClick={(i) => setPinnedLvl((p) => (p === i ? null : i))}
                    pinnedIndex={pinnedLvl != null && pinnedLvl < lvl.values.length ? pinnedLvl : null}
                  />
                </ChartExpandedContext.Provider>
              </ChartSection>
              {pinnedLvl != null && pinnedLvl < lvl.values.length && (
                <PinnedDayPanel
                  dateLabel={lvl.labels[pinnedLvl] ?? ''}
                  rows={[
                    { label: 'Подписчиков', value: fmt.num(lvl.values[pinnedLvl]!) },
                    ...(pinnedLvl > 0
                      ? [
                          {
                            label: 'К пред. дню',
                            value: (() => {
                              const d = lvl.values[pinnedLvl]! - lvl.values[pinnedLvl - 1]!;
                              return (
                                <span className={d > 0 ? 'text-verdant' : d < 0 ? 'text-ember' : undefined}>
                                  {d > 0 ? '+' : d < 0 ? '−' : ''}
                                  {fmt.num(Math.abs(d))}
                                </span>
                              );
                            })(),
                          },
                        ]
                      : []),
                  ]}
                  // Уровень — не пост-адресуемая серия: день уровня не «даёт» посты.
                  showPosts={false}
                  onClose={() => setPinnedLvl(null)}
                />
              )}
            </>
          )}

          <ChartSection
            id={`metric-${metricKey}`}
            title={metricKey === 'ig-follows' ? 'Подписки по дням' : 'По дням'}
            defaultSize="full"
            noExpand
            action={
              <SegmentedControl
                ariaLabel="Тип графика"
                className="shrink-0"
                value={kind}
                onChange={setKind}
                options={[
                  { value: 'line', content: 'Линия', ariaLabel: 'Тип графика: Линия' },
                  { value: 'bar', content: 'Столбцы', ariaLabel: 'Тип графика: Столбцы' },
                ]}
              />
            }
          >
            {n > 1 ? (
              <ChartExpandedContext.Provider value={true}>
                {kind === 'line' ? (
                  <LineChart
                    values={win.values}
                    labels={win.labels}
                    titles={win.titles}
                    height={chartH}
                    markExtremes
                    markAnomalies
                    showPoints={n <= 45}
                    ghost={ghostOk ? ghostVals : undefined}
                    ghostLabel={cmpLabel}
                    legendToggle={false}
                    yMin={0}
                    onPointClick={(i) => setPinned((p) => (p === i ? null : i))}
                    pinnedIndex={pinnedValid}
                  />
                ) : (
                  <BarChart
                    values={win.values}
                    labels={win.labels}
                    titles={win.titles}
                    height={chartH}
                    ghost={ghostOk ? ghostVals : undefined}
                    ghostLabel={cmpLabel}
                    legendToggle={false}
                    onPointClick={(i) => setPinned((p) => (p === i ? null : i))}
                    pinnedIndex={pinnedValid}
                  />
                )}
              </ChartExpandedContext.Provider>
            ) : (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Недостаточно данных за окно.</div>
            )}
            {stats.length > 0 && (
              <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-border pt-3 sm:grid-cols-4">
                {stats.map((row) => (
                  <div key={row.label} className="flex items-baseline justify-between gap-3">
                    <span className="text-xs text-muted-foreground">{row.label}</span>
                    <span className="text-sm font-medium tabular-nums">{row.value}</span>
                  </div>
                ))}
              </div>
            )}
          </ChartSection>

          {/* Тайм-бар принадлежит графику (v2): пресеты окна одной строкой сразу под канвасом,
              а не плавающей панелью у края экрана. Presets only: у архива пока нет своего диапазона. */}
          <WindowBar value={days} onChange={setDays} />

          {pinnedValid != null && pinnedDay != null && (
            <PinnedDayPanel
              dateLabel={win.labels[pinnedValid] ?? pinnedDay}
              rows={[
                { label: 'Значение', value: fmt.num(win.values[pinnedValid]) },
                ...(pinnedDiff != null
                  ? [
                      {
                        label: 'К пред. дню',
                        value: (
                          <span className={pinnedDiff > 0 ? 'text-verdant' : pinnedDiff < 0 ? 'text-ember' : undefined}>
                            {pinnedDiff > 0 ? '+' : pinnedDiff < 0 ? '−' : ''}
                            {fmt.num(Math.abs(pinnedDiff))}
                          </span>
                        ),
                      },
                    ]
                  : []),
                ...(ghostOk && ghostVals[pinnedValid] != null ? [{ label: cmpLabel, value: fmt.num(ghostVals[pinnedValid]) }] : []),
              ]}
              posts={pinnedPosts.map((post, i) => ({
                key: post.id ?? i,
                thumb: post.thumbnail_url ?? (post.media_type === 'VIDEO' ? null : post.media_url) ?? null,
                thumbLabel: post.media_type === 'VIDEO' ? 'Видео' : 'Фото',
                text: post.caption ? post.caption.slice(0, 140) : 'Без подписи',
                value: fmt.short(Number(post.reach ?? post.views ?? 0)),
                href: post.permalink ?? null,
              }))}
              postsEmpty="В этот день публикаций не было (в загруженных постах)."
              onClose={() => setPinned(null)}
            />
          )}
        </div>

        {/* Explore rail — flat hairline sections (no widget chrome: these are controls, not cards). */}
        <aside className="space-y-6">
          <RailSection title="Сравнение">
            {/* Итог окна — канонический дом итога после тихой шапки (v2: hero переехал сюда).
                Для ig-follows это текущая база (то, чем ведёт страница), не сумма подписок. */}
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs text-muted-foreground">Текущее окно</span>
              <span className="text-base font-medium tabular-nums text-foreground">
                {lvlNow != null ? fmt.kpi(lvlNow) : fmt.kpi(sumCur)}
              </span>
            </div>
            {/* На ig-follows итог выше говорит про НЕТТО-изменение базы, а rail сравнивает серию
                графика «Подписки по дням» (валовые) — одна строка контекста снимает конфликт
                (дизайн-проход №3: рецидив gross-vs-net без подписи). */}
            {metricKey === 'ig-follows' && lvlNow != null && (
              <p className="text-xs text-muted-foreground">По графику «Подписки по дням» (валовые подписки).</p>
            )}
            <SegSelect
              ariaLabel="База сравнения"
              value={cmp}
              onChange={setCmp}
              options={[
                { value: 'off' as const, label: 'Выкл' },
                { value: 'prev' as const, label: 'Пред. период' },
                { value: 'year' as const, label: 'Год назад' },
              ]}
            />
            {cmp === 'off' ? (
              <p className="text-xs text-muted-foreground">Выберите базу — пунктир прошлого окна ляжет на график.</p>
            ) : days === 0 ? (
              <p className="text-xs text-muted-foreground">Для окна «Всё» прошлого периода не существует.</p>
            ) : ghostOk ? (
              <div className="space-y-2 text-sm">
                {/* v2: строку текущего значения не дублируем — итог уже стоит первой строкой секции.
                    Исключение ig-follows: там итог = база, а здесь валовая сумма подписок окна. */}
                {lvlNow != null && (
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-xs text-muted-foreground">Текущий период</span>
                    <span className="font-medium tabular-nums">{fmt.kpi(sumCur)}</span>
                  </div>
                )}
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs text-muted-foreground">{cmpLabel}</span>
                  <span className="tabular-nums">{sumPrev != null ? fmt.kpi(sumPrev) : '—'}</span>
                </div>
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
            ) : cmp === 'year' ? (
              <p className="text-xs text-muted-foreground">Архив пока не достаёт до прошлого года — дневная история копится в ig_daily, сравнение включится само.</p>
            ) : (
              <p className="text-xs text-muted-foreground">В архиве недостаточно истории за прошлый период — сравнить не с чем.</p>
            )}
          </RailSection>

          <RailSection title="О метрике">
            <dl className="space-y-3 text-sm">
              <AboutRow label="Как считается" text={daily.formula} />
              <AboutRow label="Что учитывается" text={daily.included} />
              <AboutRow label="Источник" text={daily.source} />
            </dl>
          </RailSection>

          <Link to="/instagram/analytics" className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary/80">
            Открыть IG-аналитику <span aria-hidden="true">→</span>
          </Link>
        </aside>
      </div>
    </div>
  );
}

/** Aggregate IG metric (views / interactions / likes / saves): period-vs-period — the API gives
    totals per insights window, so a daily chart would be fabricated. Window = the GLOBAL IG
    period (the layout's 7д/30д/90д pills). */
function IgAggregatePage({ def, pair, windowDays, handle }: { def: IgAggDef; pair: WindowPair; windowDays: number; handle: string | null }) {
  // These pages live OUTSIDE the IG feed (no page period) — their window is the GLOBAL period
  // useIgData falls back to, and this is now the page's own control (the feed header used to be
  // the only steering wheel; after the feeds moved to page periods it no longer reaches here).
  const { days, setDays } = usePeriod();
  const trend = pairDelta(pair);
  const deltaPct = pair.hasPrev && pair.prev > 0 ? ((pair.cur - pair.prev) / pair.prev) * 100 : null;
  return (
    <div className="space-y-5">
      <Link to="/instagram" className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
        <span aria-hidden="true">←</span> Instagram
      </Link>

      {/* Тихая шапка v2: имя метрики ведёт, итог окна живёт в «Сравнении» справа; компактный итог
          остаётся только на узких экранах (там rail уезжает под основной блок). */}
      <div>
        <h1 className="text-2xl font-medium tracking-tight text-foreground">{def.term}</h1>
        <div className="mt-1 text-xs tracking-wide text-muted-foreground">{handle ? `Instagram ${handle}` : 'Instagram'}</div>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 lg:hidden">
          <span className="text-3xl font-medium leading-none tabular-nums tracking-tight">{pair.hasCur ? fmt.kpi(pair.cur) : '—'}</span>
          <DeltaPill delta={trend} />
          <span className="text-xs tracking-wide text-muted-foreground">{windowDays} дн.</span>
        </div>
        {/* «внизу страницы» больше не правда: тайм-бар живёт под блоком периода (v2). */}
        <div className="mt-1.5 text-xs text-muted-foreground">агрегат за выбранное окно</div>
      </div>

      <div className="relative grid grid-cols-1 gap-6 xl:gap-8 lg:grid-cols-[minmax(0,1fr)_var(--inspector-w,300px)]">
        <InspectorHandle />
        <div className="min-w-0 space-y-6">
          <ChartSection title="Период против периода" defaultSize="full" noExpand>
            {pair.hasCur ? (
              <div className="grid grid-cols-1 gap-px border-t border-border bg-border sm:grid-cols-3">
                <div className="bg-card p-4">
                  <div className="text-xs tracking-wide text-muted-foreground">Текущий период</div>
                  <div className="mt-2 text-3xl font-medium tabular-nums tracking-tight">{fmt.kpi(pair.cur)}</div>
                </div>
                <div className="bg-card p-4">
                  <div className="text-xs tracking-wide text-muted-foreground">Пред. период</div>
                  <div className="mt-2 text-3xl font-medium tabular-nums tracking-tight text-ink2">{pair.hasPrev ? fmt.kpi(pair.prev) : '—'}</div>
                </div>
                <div className="bg-card p-4">
                  <div className="text-xs tracking-wide text-muted-foreground">Изменение</div>
                  <div className={`mt-2 text-3xl font-medium tabular-nums tracking-tight ${deltaPct == null ? 'text-ink3' : deltaPct >= 0 ? 'text-verdant' : 'text-ember'}`}>
                    {deltaPct == null ? '—' : `${deltaPct >= 0 ? '▲' : '▼'}${Math.abs(deltaPct).toFixed(1)}%`}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Instagram не вернул эту метрику за период.</div>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Дневной серии для этой метрики Instagram не отдаёт — сравниваем агрегаты периодов, а не рисуем придуманный график.
            </p>
          </ChartSection>

          {/* Тайм-бар принадлежит блоку периода (v2): переключатели окна сразу под ним,
              а не плавающей панелью у края страницы. */}
          <WindowBar value={days} onChange={setDays} allowAll={false} />
        </div>

        <aside className="space-y-6">
          {/* v2: итог живёт в «Сравнении» — первая секция rail. Прошлый период у агрегатной
              страницы уже разложен в основном блоке, поэтому здесь только строка итога. */}
          <RailSection title="Сравнение">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs text-muted-foreground">Текущее окно</span>
              <span className="text-base font-medium tabular-nums text-foreground">{pair.hasCur ? fmt.kpi(pair.cur) : '—'}</span>
            </div>
          </RailSection>
          <RailSection title="О метрике">
            <dl className="space-y-3 text-sm">
              <AboutRow label="Как считается" text={def.formula} />
              <AboutRow label="Источник" text={def.source} />
            </dl>
          </RailSection>
          <Link to="/instagram/analytics" className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary/80">
            Открыть IG-аналитику <span aria-hidden="true">→</span>
          </Link>
        </aside>
      </div>
    </div>
  );
}

/** Local calendar-day key of an IG post timestamp (viewer-local, matching the series days). */
function igDayKey(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Same calendar date a year earlier; Feb 29 maps to Feb 28 (no leap counterpart). */
function shiftYearBack(day: string): string {
  const [y, m, d] = day.split('-');
  if (m === '02' && d === '29') return `${Number(y) - 1}-02-28`;
  return `${Number(y) - 1}-${m}-${d}`;
}

/** ER (derived): period-vs-period in percentage POINTS + the numerator/denominator decomposition —
    the honest form for a ratio of two period aggregates. */
function IgErPage({
  erReach,
  erReachPrev,
  interactions,
  reach,
  windowDays,
  handle,
}: {
  erReach: number;
  erReachPrev: number;
  interactions: WindowPair;
  reach: WindowPair;
  windowDays: number;
  handle: string | null;
}) {
  // GLOBAL window — this page's own control now (see IgAggregatePage).
  const { days, setDays } = usePeriod();
  const hasCur = erReach > 0;
  const hasPrev = erReachPrev > 0;
  const deltaPp = hasCur && hasPrev ? erReach - erReachPrev : null;
  const trend = hasCur && hasPrev ? pctDelta(erReach, erReachPrev) : null;
  return (
    <div className="space-y-5">
      <Link to="/instagram" className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
        <span aria-hidden="true">←</span> Instagram
      </Link>

      {/* Тихая шапка v2: имя метрики ведёт, итог окна живёт в «Сравнении» справа; компактный итог
          остаётся только на узких экранах (там rail уезжает под основной блок). */}
      <div>
        <h1 className="text-2xl font-medium tracking-tight text-foreground">{ER_DEF.term}</h1>
        <div className="mt-1 text-xs tracking-wide text-muted-foreground">{handle ? `Instagram ${handle}` : 'Instagram'}</div>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 lg:hidden">
          <span className="text-3xl font-medium leading-none tabular-nums tracking-tight">{hasCur ? `${erReach.toFixed(2)}%` : '—'}</span>
          <DeltaPill delta={trend} />
          <span className="text-xs tracking-wide text-muted-foreground">{windowDays} дн.</span>
        </div>
        {/* «внизу страницы» больше не правда: тайм-бар живёт под блоком периода (v2). */}
        <div className="mt-1.5 text-xs text-muted-foreground">агрегат за выбранное окно</div>
      </div>

      <div className="relative grid grid-cols-1 gap-6 xl:gap-8 lg:grid-cols-[minmax(0,1fr)_var(--inspector-w,300px)]">
        <InspectorHandle />
        <div className="min-w-0 space-y-6">
          <ChartSection title="Период против периода" defaultSize="full" noExpand>
            {hasCur ? (
              <>
                <div className="grid grid-cols-1 gap-px border-t border-border bg-border sm:grid-cols-3">
                  <div className="bg-card p-4">
                    <div className="text-xs tracking-wide text-muted-foreground">Текущий период</div>
                    <div className="mt-2 text-3xl font-medium tabular-nums tracking-tight">{erReach.toFixed(2)}%</div>
                  </div>
                  <div className="bg-card p-4">
                    <div className="text-xs tracking-wide text-muted-foreground">Пред. период</div>
                    <div className="mt-2 text-3xl font-medium tabular-nums tracking-tight text-ink2">{hasPrev ? `${erReachPrev.toFixed(2)}%` : '—'}</div>
                  </div>
                  <div className="bg-card p-4">
                    <div className="text-xs tracking-wide text-muted-foreground">Изменение</div>
                    <div className={`mt-2 text-3xl font-medium tabular-nums tracking-tight ${deltaPp == null ? 'text-ink3' : deltaPp >= 0 ? 'text-verdant' : 'text-ember'}`}>
                      {deltaPp == null ? '—' : `${deltaPp >= 0 ? '+' : '−'}${Math.abs(deltaPp).toFixed(2)} п.п.`}
                    </div>
                  </div>
                </div>
                {/* The reconcile line (TG metric-page idiom): the ratio unfolded into its parts. */}
                <p className="mt-3 text-xs text-muted-foreground">
                  ER = {fmt.kpi(interactions.cur)} взаимодействий ÷ {fmt.kpi(reach.cur)} охвата × 100% = {erReach.toFixed(2)}%
                </p>
              </>
            ) : (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Instagram не вернул составляющие ER за период.</div>
            )}
          </ChartSection>

          {/* Тайм-бар принадлежит блоку периода (v2): переключатели окна сразу под ним,
              а не плавающей панелью у края страницы. */}
          <WindowBar value={days} onChange={setDays} allowAll={false} />
        </div>

        <aside className="space-y-6">
          {/* v2: итог живёт в «Сравнении» — первая секция rail. Прошлый период у ER уже
              разложен в основном блоке, поэтому здесь только строка итога. */}
          <RailSection title="Сравнение">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs text-muted-foreground">Текущее окно</span>
              <span className="text-base font-medium tabular-nums text-foreground">{hasCur ? `${erReach.toFixed(2)}%` : '—'}</span>
            </div>
          </RailSection>
          <RailSection title="О метрике">
            <dl className="space-y-3 text-sm">
              <AboutRow label="Как считается" text={ER_DEF.formula} />
              <AboutRow label="Источник" text={ER_DEF.source} />
            </dl>
          </RailSection>
          <Link to="/instagram/analytics" className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary/80">
            Открыть IG-аналитику <span aria-hidden="true">→</span>
          </Link>
        </aside>
      </div>
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

// ── IG chart-card pages (/metrics/ig-{age,gender,countries,cities,best-time,format-engagement,
//    reels-watch-time,story-navigation}) ─────────────────────────────────────────────────────────
// The demographic/format/story-navigation cards were generic ?detail= overlays; they now each drill
// to a dedicated full page of the SAME shell/grammar as /metrics/ig-reach (back link, quiet header
// with source identity + descriptor, full-height main card, right rail «Сравнение»/«О метрике»).
// ЧЕСТНОСТЬ over parity: demographics are a follower-base snapshot (no window/comparison); best-time
// is its own 7×24 heatmap; Reels is per-post categorical (bars, no fabricated period comparison);
// format-engagement + Reels follow the GLOBAL period through useIgData (window bar), the rest don't.

interface IgAboutDef {
  formula: string;
  included?: string;
  source: string;
}

/** Тихая шапка + две колонки (главный блок + rail «Сравнение»/«О метрике»), как у `/metrics/ig-reach`. */
function IgChartShell({
  back,
  term,
  handle,
  descriptor,
  comparison,
  about,
  children,
}: {
  back: { to: string; label: string };
  term: string;
  handle: string | null;
  descriptor?: string;
  comparison: ReactNode;
  about: IgAboutDef;
  children: ReactNode;
}) {
  return (
    <div className="space-y-5">
      <Link to={back.to} className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
        <span aria-hidden="true">←</span> {back.label}
      </Link>

      <div>
        <h1 className="text-2xl font-medium tracking-tight text-foreground">{term}</h1>
        <div className="mt-1 text-xs tracking-wide text-muted-foreground">{handle ? `Instagram ${handle}` : 'Instagram'}</div>
        {descriptor && <div className="mt-1.5 text-xs text-muted-foreground">{descriptor}</div>}
      </div>

      <div className="relative grid grid-cols-1 gap-6 xl:gap-8 lg:grid-cols-[minmax(0,1fr)_var(--inspector-w,300px)]">
        <InspectorHandle />
        <div className="min-w-0 space-y-6">{children}</div>
        <aside className="space-y-6">
          <RailSection title="Сравнение">{comparison}</RailSection>
          <RailSection title="О метрике">
            <dl className="space-y-3 text-sm">
              <AboutRow label="Как считается" text={about.formula} />
              {about.included && <AboutRow label="Что учитывается" text={about.included} />}
              <AboutRow label="Источник" text={about.source} />
            </dl>
          </RailSection>
          <Link to={back.to} className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary/80">
            Открыть раздел <span aria-hidden="true">→</span>
          </Link>
        </aside>
      </div>
    </div>
  );
}

/** Full-height (non-expandable) card whose body renders expanded — the IG mirror of YmReportCard.
    ChartExpandedContext keeps Breakdown at its full list; ExpandedChartHeightContext feeds charts. */
function IgReportCard({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const chartH = useExplorerChartHeight();
  return (
    <ChartSection id={id} title={title} defaultSize="full" noExpand>
      <ChartExpandedContext.Provider value={true}>
        <ExpandedChartHeightContext.Provider value={chartH}>{children}</ExpandedChartHeightContext.Provider>
      </ChartExpandedContext.Provider>
    </ChartSection>
  );
}

/** Honest «Сравнение» text — a snapshot/breakdown, not a period metric. */
function IgNoComparison({ text }: { text: string }) {
  return <p className="text-xs leading-relaxed text-muted-foreground">{text}</p>;
}

const IG_BACK = {
  audience: { to: '/instagram/audience', label: 'Instagram · Аудитория' },
  content: { to: '/instagram/content', label: 'Instagram · Контент' },
} as const;

/** The relevant React Query result gating one chart page (loading / error / retry). */
interface IgQueryLike {
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: () => unknown;
}

interface IgBreakdownPageDef {
  cardId: string;
  back: { to: string; label: string };
  term: string;
  descriptor: string;
  cardTitle: string;
  about: IgAboutDef;
  comparison: string;
  /** Post/timeframe-derived pages carry the GLOBAL period window bar; snapshots don't. */
  periodControl: boolean;
  query: (ig: IgData) => IgQueryLike;
  derive: (ig: IgData) => IgBreakdownItem[];
  errorTitle: string;
  empty: string;
  footer?: (ig: IgData, items: IgBreakdownItem[]) => ReactNode;
  /** Content views may be campaign-scoped through the canonical `?campaign=` URL parameter. */
  contentView?: 'formats';
}

const DEMOGRAPHIC_COMPARISON =
  'Разрез аудитории по подписчикам — снимок базы, а не метрика периода; сравнение периодов здесь не рассчитывается.';

const IG_BREAKDOWN_DEFS: Record<string, IgBreakdownPageDef> = {
  'ig-age': {
    cardId: 'ig-page-age',
    back: IG_BACK.audience,
    term: 'Возраст',
    descriptor: 'Возрастные группы подписчиков — оценка Instagram по демографии базы',
    cardTitle: 'Возрастные группы',
    about: {
      formula: 'Подписчики группируются по возрастной корзине (follower_demographics · age) в фиксированном порядке 13–17 … 65+.',
      included: 'Это снимок текущей базы подписчиков, а не срез за период. Instagram отдаёт демографию только для аккаунтов от 100 подписчиков и показывает лишь топ-сегменты.',
      source: 'Instagram insights (follower_demographics, age).',
    },
    comparison: DEMOGRAPHIC_COMPARISON,
    periodControl: false,
    query: (ig) => ig.queries.breakdowns,
    derive: (ig) => igAgeItems(ig.breakdowns),
    errorTitle: 'Не удалось загрузить демографию',
    empty: 'Возрастной демографии для этого аккаунта нет (нужно 100+ подписчиков).',
    footer: (ig, items) => {
      const covered = items.reduce((acc, a) => acc + a.value, 0);
      const coverage = ig.followers > 0 && covered > 0 ? covered / ig.followers : 1;
      if (coverage >= 0.98) return null;
      return (
        <p className="mt-3 text-2xs text-muted-foreground/70">
          Охвачено ≈{Math.round(coverage * 100)}% аудитории — Instagram показывает только топ-сегменты.
        </p>
      );
    },
  },
  'ig-gender': {
    cardId: 'ig-page-gender',
    back: IG_BACK.audience,
    term: 'Пол',
    descriptor: 'Пол подписчиков — оценка Instagram по демографии базы',
    cardTitle: 'По полу',
    about: {
      formula: 'Подписчики группируются по полу (follower_demographics · gender), ранжируются по величине.',
      included: 'Снимок текущей базы, а не срез за период. Доступно только для аккаунтов от 100 подписчиков.',
      source: 'Instagram insights (follower_demographics, gender).',
    },
    comparison: DEMOGRAPHIC_COMPARISON,
    periodControl: false,
    query: (ig) => ig.queries.breakdowns,
    derive: (ig) => igGenderItems(ig.breakdowns),
    errorTitle: 'Не удалось загрузить демографию',
    empty: 'Демографии по полу для этого аккаунта нет (нужно 100+ подписчиков).',
  },
  'ig-countries': {
    cardId: 'ig-page-countries',
    back: IG_BACK.audience,
    term: 'Топ стран',
    descriptor: 'География подписчиков по странам — полный список',
    cardTitle: 'Все страны',
    about: {
      formula: 'Подписчики группируются по стране (follower_demographics · country); коды стран локализуются. Полный ранжированный список (карточка показывает топ-8).',
      included: 'Снимок текущей базы, а не срез за период. Доступно только для аккаунтов от 100 подписчиков.',
      source: 'Instagram insights (follower_demographics, country).',
    },
    comparison: DEMOGRAPHIC_COMPARISON,
    periodControl: false,
    query: (ig) => ig.queries.breakdowns,
    derive: (ig) => igCountryItems(ig.breakdowns),
    errorTitle: 'Не удалось загрузить географию',
    empty: 'Данных по странам для этого аккаунта нет (нужно 100+ подписчиков).',
  },
  'ig-cities': {
    cardId: 'ig-page-cities',
    back: IG_BACK.audience,
    term: 'Топ городов',
    descriptor: 'География подписчиков по городам — полный список',
    cardTitle: 'Все города',
    about: {
      formula: 'Подписчики группируются по городу (follower_demographics · city); названия локализуются, регион отбрасывается. Полный ранжированный список (карточка показывает топ-8).',
      included: 'Снимок текущей базы, а не срез за период. Доступно только для аккаунтов от 100 подписчиков.',
      source: 'Instagram insights (follower_demographics, city).',
    },
    comparison: DEMOGRAPHIC_COMPARISON,
    periodControl: false,
    query: (ig) => ig.queries.breakdowns,
    derive: (ig) => igCityItems(ig.breakdowns),
    errorTitle: 'Не удалось загрузить географию',
    empty: 'Данных по городам для этого аккаунта нет (нужно 100+ подписчиков).',
  },
  'ig-format-engagement': {
    cardId: 'ig-page-format-engagement',
    back: IG_BACK.content,
    term: 'Вовлечённость по форматам',
    descriptor: 'Как распределяются взаимодействия аккаунта по формату за выбранное окно',
    cardTitle: 'Вовлечённость по форматам',
    about: {
      formula: 'Взаимодействия аккаунта (total_interactions) группируются по формату (Лента/Reels/Stories/Карусель), ранжируются по величине.',
      included: 'Это разрез аккаунта за окно инсайтов Instagram, а не сумма по загруженным постам. Меняйте окно, чтобы пересобрать карточку.',
      source: 'Instagram insights (total_interactions · media_product_type).',
    },
    comparison:
      'Это разрез вовлечённости по форматам за окно, а не одна метрика периода — сравнение периодов не рассчитывается. Меняйте окно, чтобы пересобрать карточку.',
    periodControl: true,
    query: (ig) => ig.queries.breakdowns,
    derive: (ig) => igFormatEngagementItems(ig.formatItems),
    errorTitle: 'Не удалось загрузить разрез по форматам',
    empty: 'Нет данных о форматах за период.',
    contentView: 'formats',
  },
  'ig-story-navigation': {
    cardId: 'ig-page-story-navigation',
    back: { to: '/instagram/content?more=stories', label: 'Instagram · Контент' },
    term: 'Навигация по историям',
    descriptor: 'Как зрители переходят между активными историями за 24-часовое окно',
    cardTitle: 'Навигация по историям',
    about: {
      formula: 'Суммарные действия навигации активных историй: «Вперёд» (tap_forward), «Назад» (tap_back), «Выход» (tap_exit), «Свайп к следующему» (swipe_forward).',
      included: 'Истории живут 24 часа — это разрез активных историй, а не срез за выбранный период. Пустые действия скрыты.',
      source: 'Instagram Stories insights (navigation).',
    },
    comparison:
      'Навигация по активным историям за 24-часовое окно Instagram — не метрика периода; сравнение периодов не рассчитывается.',
    periodControl: false,
    query: (ig) => ig.queries.stories,
    derive: (ig) => igStoryNavItems(ig.stories),
    errorTitle: 'Не удалось загрузить истории',
    empty: 'Нет данных о навигации по историям.',
  },
};

/** /metrics/ig-* chart-card dispatcher: heatmap and Reels get bespoke bodies; every categorical
    breakdown shares one truthful rank-list page (Breakdown, no fabricated chart/comparison). */
function IgChartMetricPage({ metricKey, ig, handle }: { metricKey: string; ig: IgData; handle: string | null }) {
  const contentScope = useIgScopedPosts(ig);
  if (metricKey === 'ig-best-time') return <IgBestTimePage ig={ig} handle={handle} />;
  if (metricKey === 'ig-reels-watch-time') {
    return <IgReelsWatchTimePage ig={ig} handle={handle} contentScope={contentScope} />;
  }
  const def = IG_BREAKDOWN_DEFS[metricKey];
  if (!def) return null;
  return <IgBreakdownPage def={def} ig={ig} handle={handle} contentScope={contentScope} />;
}

type IgContentScope = ReturnType<typeof useIgScopedPosts>;

function contentBack(view: 'formats' | 'reels', campaignId: number | null): { to: string; label: string } {
  const params = new URLSearchParams({ more: view });
  if (campaignId != null) params.set('campaign', String(campaignId));
  return { to: `/instagram/content?${params.toString()}`, label: 'Instagram · Контент' };
}

function IgBreakdownPage({
  def,
  ig,
  handle,
  contentScope,
}: {
  def: IgBreakdownPageDef;
  ig: IgData;
  handle: string | null;
  contentScope: IgContentScope;
}) {
  const { days, setDays } = usePeriod();
  const campaignScoped = def.contentView != null && contentScope.campaignId != null;
  const queries: IgQueryLike[] = campaignScoped
    ? [ig.queries.posts, contentScope.campaignPostsQ]
    : [def.query(ig)];
  const pending = queries.some((q) => q.isPending);
  const error = queries.some((q) => q.isError);
  const fetching = queries.some((q) => q.isFetching);
  const items =
    !pending && !error
      ? def.contentView === 'formats'
        ? igFormatEngagementItems(contentScope.formatItems)
        : def.derive(ig)
      : [];
  const back =
    def.contentView != null
      ? contentBack(def.contentView, contentScope.campaignId)
      : def.back;
  return (
    <IgChartShell
      back={back}
      term={def.term}
      handle={handle}
      descriptor={def.descriptor}
      comparison={<IgNoComparison text={def.comparison} />}
      about={def.about}
    >
      <IgReportCard id={def.cardId} title={def.cardTitle}>
        {pending ? (
          <Skeleton className="h-[360px] w-full" />
        ) : error ? (
          <ErrorState
            title={def.errorTitle}
            onRetry={() => queries.forEach((q) => void q.refetch())}
            retrying={fetching}
          />
        ) : items.length === 0 ? (
          <EmptyState compact size="chart" title={def.empty} />
        ) : (
          <>
            <Breakdown items={items} />
            {def.footer?.(ig, items)}
          </>
        )}
      </IgReportCard>
      {def.periodControl && <WindowBar value={days} onChange={setDays} allowAll={false} />}
    </IgChartShell>
  );
}

/** Reels watch time — per-post categorical bars + a Reels/avg/total summary. No Line/Bar toggle and
    no fabricated period comparison; the GLOBAL period still narrows the post set through useIgData. */
function IgReelsWatchTimePage({
  ig,
  handle,
  contentScope,
}: {
  ig: IgData;
  handle: string | null;
  contentScope: IgContentScope;
}) {
  const { days, setDays } = usePeriod();
  const chartH = useExplorerChartHeight();
  const queries: IgQueryLike[] =
    contentScope.campaignId != null
      ? [ig.queries.posts, contentScope.campaignPostsQ]
      : [ig.queries.posts];
  const pending = queries.some((q) => q.isPending);
  const error = queries.some((q) => q.isError);
  const fetching = queries.some((q) => q.isFetching);
  const r = igReelsWatchTime(contentScope.posts);
  return (
    <IgChartShell
      back={contentBack('reels', contentScope.campaignId)}
      term="Ср. время просмотра по Reels"
      handle={handle}
      descriptor="Удержание Reels за выбранное окно — среднее время просмотра по каждому ролику"
      comparison={
        <IgNoComparison text="Показатели по каждому Reels за окно — это разрез по публикациям, а не метрика периода; сравнение с прошлым периодом не рассчитывается." />
      }
      about={{
        formula:
          'Для каждого Reels окна — среднее время просмотра (ig_reels_avg_watch_time) в секундах, столбец на ролик. Сводка: число Reels, среднее по роликам и суммарно просмотренные часы.',
        included:
          'Только медиа-продукт REELS из загруженных публикаций окна; Reels без метрики удержания дают 0. Глубина ограничена ~24 последними публикациями (как в Контенте).',
        source: 'Instagram insights по публикациям (ig_reels_avg_watch_time, ig_reels_video_view_total_time).',
      }}
    >
      <IgReportCard id="ig-page-reels-watch-time" title="Ср. время просмотра по Reels">
        {pending ? (
          <Skeleton className="h-[360px] w-full" />
        ) : error ? (
          <ErrorState
            title="Не удалось загрузить публикации"
            onRetry={() => queries.forEach((q) => void q.refetch())}
            retrying={fetching}
          />
        ) : r.count === 0 ? (
          <EmptyState compact size="chart" title="За выбранный период Reels нет." />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-x-6 gap-y-4 border-t border-border pt-4 sm:grid-cols-3">
              <KpiCard label="Reels" value={fmt.num(r.count)} />
              <KpiCard label="Ср. время просмотра" value={`${r.avgWatchAll} сек`} />
              <KpiCard label="Суммарно просмотрено" value={`${fmt.short(Math.round(r.totalWatchHours))} ч`} />
            </div>
            <BarChart values={r.values} labels={r.labels} titles={r.titles} height={chartH} />
          </div>
        )}
      </IgReportCard>
      <WindowBar value={days} onChange={setDays} allowAll={false} />
    </IgChartShell>
  );
}

/** Best time — the online_followers 7×24 heatmap in its own shape (no Line/Bar/comparison). The
    body owns the honest empty state (online_followers is frequently empty on the new IG-Login API). */
function IgBestTimePage({ ig, handle }: { ig: IgData; handle: string | null }) {
  const q = ig.queries.online;
  return (
    <IgChartShell
      back={IG_BACK.audience}
      term="Лучшее время для публикации"
      handle={handle}
      descriptor="Когда подписчики онлайн — сетка 7×24 по средней активности аудитории"
      comparison={
        <IgNoComparison text="Тепловая карта онлайна аудитории — форма распределения, а не одна метрика периода; сравнение периодов не рассчитывается." />
      }
      about={{
        formula:
          'Для каждого слота (день недели × час) — среднее число подписчиков онлайн из метрики online_followers; насыщенность нормирована на максимум, лучший слот отмечен рамкой.',
        included:
          'Часы — в UTC, как отдаёт Instagram. Метрика доступна не всегда и требует 100+ подписчиков — при пустом ответе показываем честное пустое состояние, а не выдуманный слот.',
        source: 'Instagram insights (online_followers).',
      }}
    >
      <IgReportCard id="ig-page-best-time" title="По дням недели и часам">
        {q.isPending ? (
          <Skeleton className="h-[360px] w-full" />
        ) : q.isError ? (
          <ErrorState title="Не удалось загрузить активность аудитории" onRetry={() => void q.refetch()} retrying={q.isFetching} />
        ) : (
          <BestTimeHeatmap online={ig.online} />
        )}
      </IgReportCard>
    </IgChartShell>
  );
}
