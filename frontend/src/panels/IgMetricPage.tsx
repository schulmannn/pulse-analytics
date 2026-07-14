import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useIgData } from '@/lib/useIgData';
import { usePeriod, type PeriodDays } from '@/lib/period';
import { pairDelta } from '@/lib/igMetrics';
import type { WindowPair } from '@/lib/igMetrics';
import { pctDelta } from '@/lib/delta';
import { fmt } from '@/lib/format';
import { windowIgSeries, ChartSection as RailSection } from '@/components/instagram/shared';
import { ChartSection } from '@/components/ChartWidget';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { ChartExpandedContext } from '@/components/ExpandableChart';
import { DeltaPill } from '@/components/DeltaPill';
import { ErrorState } from '@/components/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';
import { PinnedDayPanel } from '@/components/PinnedDayPanel';
import { MetricPage, SegSelect } from '@/panels/MetricPage';
import { useExplorerChartHeight } from '@/lib/useExplorerChartHeight';

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
  return raw != null && (raw in DAILY_DEFS || raw in AGG_DEFS || raw === 'ig-er');
}

/** /metrics/:key dispatcher: TG keys → the TG explorer, ig-* keys → the IG page. MetricPage
    itself redirects unknown keys home, so the fallthrough stays safe. */
export function MetricRoute() {
  const { key } = useParams<{ key: string }>();
  if (isIgMetricKey(key)) return <IgMetricPage metricKey={key!} />;
  return <MetricPage />;
}

const WINDOW_PILLS = [
  { days: 7, label: '7д' },
  { days: 30, label: '30д' },
  { days: 90, label: '90д' },
  { days: 0, label: 'Всё' },
];

/** Sticky bottom window bar (steep) — presets only. The daily explorer feeds it a page-local
    window; the aggregate/ER pages wire it to the GLOBAL period (their windows live in useIgData),
    so every /metrics/ig-* page carries its own control — the feed header stopped being the only
    steering wheel when the feeds moved to the page-period system.
    Solid, не blur-пилл: плавающая полупрозрачная пилюля на TG-странице уже была признана багом
    и заменена сплошным баром (#109) — это рецидив того же паттерна (дизайн-проход №3).
    `allowAll` = false на агрегатных/ER-страницах: живые insights не отдают «всё время», чип «Всё»
    молча показывал 90д — окно, которое страница не может исполнить, не предлагаем. */
function WindowBar({ value, onChange, allowAll = true }: { value: number; onChange: (days: PeriodDays) => void; allowAll?: boolean }) {
  return (
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-border bg-background px-1 py-2 print:hidden">
      <span className="text-xs font-medium text-muted-foreground">Окно</span>
      <span className="flex-1" />
      {WINDOW_PILLS.filter((chip) => allowAll || chip.days !== 0).map((chip) => (
        <button
          key={chip.days}
          type="button"
          aria-pressed={value === chip.days}
          onClick={() => onChange(chip.days as PeriodDays)}
          className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
            value === chip.days ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'
          }`}
        >
          {chip.label}
        </button>
      ))}
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

      {/* Compact steep headline — the topbar h1 already names the metric. Для ig-follows при
          живом уровне headline = текущая база и её изменение за окно (как ТГ «Подписчики»),
          а не сумма подписок — сумма остаётся в статистике под графиком «Подписки по дням». */}
      {lvlNow != null ? (
        <div>
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="text-hero font-medium leading-none tabular-nums tracking-tight">{fmt.kpi(lvlNow)}</span>
            <DeltaPill delta={lvlTrend} />
            <span className="text-xs tracking-wide text-muted-foreground">
              Подписчики · {periodLabel}
              {handle ? <span className="text-ink3"> · Instagram {handle}</span> : null}
            </span>
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
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="text-hero font-medium leading-none tabular-nums tracking-tight">{fmt.kpi(sumCur)}</span>
            <DeltaPill delta={trend} />
            <span className="text-xs tracking-wide text-muted-foreground">
              {daily.term} · {periodLabel}
              {handle ? <span className="text-ink3"> · Instagram {handle}</span> : null}
            </span>
          </div>
          <div className="mt-1.5 text-xs text-muted-foreground">сумма по дням за окно</div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
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
                    emphasizeLastLabel
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
              <div role="group" aria-label="Тип графика" className="flex shrink-0 overflow-hidden rounded border border-border">
                {(['line', 'bar'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={kind === k}
                    onClick={() => setKind(k)}
                    className={`border-r border-border px-2.5 py-1 text-xs font-medium transition-colors last:border-r-0 ${
                      kind === k ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {k === 'line' ? 'Линия' : 'Столбцы'}
                  </button>
                ))}
              </div>
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
                    emphasizeLastLabel
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
            {/* На ig-follows headline говорит про НЕТТО-изменение базы, а rail сравнивает серию
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
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs text-muted-foreground">Текущий период</span>
                  <span className="font-medium tabular-nums">{fmt.kpi(sumCur)}</span>
                </div>
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

      {/* Bottom window bar (steep). Presets only: the archive has no custom-range picker yet. */}
      <WindowBar value={days} onChange={setDays} />
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

      <div>
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span className="text-hero font-medium leading-none tabular-nums tracking-tight">{pair.hasCur ? fmt.kpi(pair.cur) : '—'}</span>
          <DeltaPill delta={trend} />
          <span className="text-xs tracking-wide text-muted-foreground">
            {def.term} · {windowDays} дн.
            {handle ? <span className="text-ink3"> · Instagram {handle}</span> : null}
          </span>
        </div>
        <div className="mt-1.5 text-xs text-muted-foreground">агрегат за окно — переключатели внизу страницы</div>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
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
        </div>

        <aside className="space-y-6">
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

      <WindowBar value={days} onChange={setDays} allowAll={false} />
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

      <div>
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span className="text-hero font-medium leading-none tabular-nums tracking-tight">{hasCur ? `${erReach.toFixed(2)}%` : '—'}</span>
          <DeltaPill delta={trend} />
          <span className="text-xs tracking-wide text-muted-foreground">
            {ER_DEF.term} · {windowDays} дн.
            {handle ? <span className="text-ink3"> · Instagram {handle}</span> : null}
          </span>
        </div>
        <div className="mt-1.5 text-xs text-muted-foreground">агрегат за окно — переключатели внизу страницы</div>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
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
        </div>

        <aside className="space-y-6">
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

      <WindowBar value={days} onChange={setDays} allowAll={false} />
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
