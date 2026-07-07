import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useIgData } from '@/lib/useIgData';
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
import { MetricPage, SegSelect, useExplorerChartHeight } from '@/panels/MetricPage';

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
  seriesKey: 'reach' | 'follower';
  formula: string;
  included: string;
  source: string;
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
    formula: 'Новые подписки по дням; заголовок — сумма за выбранное окно.',
    included:
      'Только валовые подписки: отписки Instagram по дням не отдаёт (итог за период — в «Движении аудитории» на Аналитике).',
    source: 'Instagram insights (follows) + дневной архив ig_daily.',
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

export function isIgMetricKey(raw: string | undefined): boolean {
  return raw != null && (raw in DAILY_DEFS || raw in AGG_DEFS);
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

export function IgMetricPage({ metricKey }: { metricKey: string }) {
  const ig = useIgData();
  const chartH = useExplorerChartHeight();
  // Page-local window for the daily explorer (the aggregate pages follow the GLOBAL IG period —
  // aggregates only exist per insights window, so a local window would have nothing to slice).
  const [days, setDays] = useState(30);
  const [kind, setKind] = useState<'line' | 'bar'>('line');
  const [cmp, setCmp] = useState<'off' | 'prev'>('prev');

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
    return <ErrorState title="Не удалось загрузить данные Instagram" reason="Instagram API недоступен" />;
  }

  const handle = ig.profile?.username ? `@${ig.profile.username}` : null;
  const daily = DAILY_DEFS[metricKey];
  if (!daily) {
    return <IgAggregatePage def={AGG_DEFS[metricKey]} pair={ig.pairs[AGG_DEFS[metricKey].pairKey]} windowDays={ig.window.days} handle={handle} />;
  }

  // ── Daily explorer (reach / follows) ────────────────────────────────────────────────────
  const seriesFull = ig.series[daily.seriesKey].filter((p) => p.day !== 'total');
  const win = windowIgSeries(seriesFull, days, daily.genitive);
  const n = win.values.length;
  // Comparison baseline: the same-length slice right BEFORE the window. Only offered when the
  // archive actually reaches that far — a partial baseline would understate the previous period.
  const prevSlice = days > 0 && seriesFull.length >= 2 * n ? seriesFull.slice(-(2 * n), -n) : [];
  const ghostVals = prevSlice.map((p) => p.value);
  const ghostOk = cmp === 'prev' && days > 0 && n > 1 && ghostVals.length === n;

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

      {/* Compact steep headline — the topbar h1 already names the metric. */}
      <div>
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span className="text-3xl font-medium leading-none tabular-nums tracking-tight">{fmt.kpi(sumCur)}</span>
          <DeltaPill delta={trend} />
          <span className="text-xs tracking-wide text-muted-foreground">
            {daily.term} · {periodLabel}
            {handle ? <span className="text-ink3"> · Instagram {handle}</span> : null}
          </span>
        </div>
        <div className="mt-1.5 text-xs text-muted-foreground">сумма по дням за окно</div>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          <ChartSection
            id={`metric-${metricKey}`}
            title="По дням"
            defaultSize="full"
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
                    ghostLabel="Пред. период"
                    legendToggle={false}
                    yMin={0}
                    emphasizeLastLabel
                  />
                ) : (
                  <BarChart values={win.values} labels={win.labels} titles={win.titles} height={chartH} ghost={ghostOk ? ghostVals : undefined} ghostLabel="Пред. период" legendToggle={false} />
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
        </div>

        {/* Explore rail — flat hairline sections (no widget chrome: these are controls, not cards). */}
        <aside className="space-y-6">
          <RailSection title="Сравнение">
            <SegSelect
              ariaLabel="База сравнения"
              value={cmp}
              onChange={setCmp}
              options={[
                { value: 'off' as const, label: 'Выкл' },
                { value: 'prev' as const, label: 'Пред. период' },
              ]}
            />
            {cmp === 'off' ? (
              <p className="text-xs text-muted-foreground">Включите сравнение — пунктир прошлого окна ляжет на график.</p>
            ) : days === 0 ? (
              <p className="text-xs text-muted-foreground">Для окна «Всё» прошлого периода не существует.</p>
            ) : ghostOk ? (
              <div className="space-y-2 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs text-muted-foreground">Текущий период</span>
                  <span className="font-medium tabular-nums">{fmt.kpi(sumCur)}</span>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs text-muted-foreground">Пред. период</span>
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
      <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background/95 px-3 py-2 backdrop-blur print:hidden">
        <span className="text-xs font-medium text-muted-foreground">Окно</span>
        <span className="flex-1" />
        {WINDOW_PILLS.map((chip) => (
          <button
            key={chip.days}
            type="button"
            aria-pressed={days === chip.days}
            onClick={() => setDays(chip.days)}
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
              days === chip.days ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            {chip.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Aggregate IG metric (views / interactions / likes / saves): period-vs-period — the API gives
    totals per insights window, so a daily chart would be fabricated. Window = the GLOBAL IG
    period (the layout's 7д/30д/90д pills). */
function IgAggregatePage({ def, pair, windowDays, handle }: { def: IgAggDef; pair: WindowPair; windowDays: number; handle: string | null }) {
  const trend = pairDelta(pair);
  const deltaPct = pair.hasPrev && pair.prev > 0 ? ((pair.cur - pair.prev) / pair.prev) * 100 : null;
  return (
    <div className="space-y-5">
      <Link to="/instagram" className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
        <span aria-hidden="true">←</span> Instagram
      </Link>

      <div>
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span className="text-3xl font-medium leading-none tabular-nums tracking-tight">{pair.hasCur ? fmt.kpi(pair.cur) : '—'}</span>
          <DeltaPill delta={trend} />
          <span className="text-xs tracking-wide text-muted-foreground">
            {def.term} · {windowDays} дн.
            {handle ? <span className="text-ink3"> · Instagram {handle}</span> : null}
          </span>
        </div>
        <div className="mt-1.5 text-xs text-muted-foreground">окно управляется общим периодом Instagram (переключатели сверху)</div>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          <ChartSection title="Период против периода" defaultSize="full">
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
