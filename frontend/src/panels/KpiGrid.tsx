import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ValueSwap } from '@/components/ValueSwap';
import { ChartBand } from '@/components/ChartBand';
import { useChannels, useHistory, useTgFull } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { lttbDownsample } from '@/lib/downsample';
import { CHART_MAX_POINTS } from '@/lib/msSeries';
import { fmt } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ErrorState } from '@/components/ErrorState';
import { Sparkline } from '@/components/Sparkline';
import { BarChart } from '@/components/BarChart';
import { MetricInfo } from '@/components/InfoTooltip';
import { DeltaPill } from '@/components/DeltaPill';
import { Skeleton } from '@/components/ui/skeleton';
import { ChartCardBody } from '@/components/ChartWidget';
import { CenteredStat, CompactStatHeadline } from '@/components/CompareStat';
import { useCardShowsPeriod, usePagePeriod, useWidgetPeriod, widgetPeriodValue } from '@/lib/period';
import { useWidgetInView } from '@/lib/widgetViewport';
import type { MetricDelta } from '@/lib/delta';
import { getDrillMetric, type MetricDef } from '@/lib/widgetMetrics';
import { deriveKpis } from '@/lib/kpiDerive';
import type { DailySeries, DrillKey } from '@/lib/kpiDerive';

/**
 * Shared TG KPI derivation. A feed-level page period wins when this hook sits above individual
 * ChartSections (the split Overview); otherwise the nearest widget period keeps legacy Home cards
 * independent. Runs the ONE canonical deriveKpis pass used by the metric pages.
 */
export function useTgKpis() {
  const pagePeriod = usePagePeriod();
  const widgetPeriod = useWidgetPeriod();
  const period = useMemo(
    () => pagePeriod ? widgetPeriodValue(pagePeriod.days, pagePeriod.range) : widgetPeriod,
    [pagePeriod, widgetPeriod],
  );
  const { days, inRange } = period;
  const range = pagePeriod?.range ?? null;
  // Прогрессивная загрузка Главной: легаси-«Показатели» на доске (тело внутри ChartSection с
  // homeKey) не фетчат офскрин. На Обзоре хук живёт на уровне страницы — контекст = true.
  const inView = useWidgetInView();
  const { data, isPending, isError, error } = useTgFull(0, { enabled: inView });
  const { data: history } = useHistory(730, { enabled: inView });
  const { channelId } = useSelectedChannel();
  const { data: channelsData } = useChannels();
  const derived = useMemo(
    () => deriveKpis(data, history, channelsData, channelId, days, range, inRange),
    [data, history, channelsData, channelId, days, range, inRange],
  );
  return { derived, isPending, isError, error };
}

export type TgKpiState = ReturnType<typeof useTgKpis>;

/** Small stand-in while the shared fetch is pending — mirrors the compact card's number + rows. */
function CompactSkeleton() {
  return (
    <div className="flex h-full flex-col justify-between gap-4">
      <Skeleton className="h-9 w-24" />
      <div className="space-y-2.5">
        <Skeleton className="h-2 w-full" />
        <Skeleton className="h-2 w-4/5" />
      </div>
    </div>
  );
}

/** Split a formatted value ("7.9k" / "8.20%") into [number, unit] so the unit reads quieter. */
function splitUnit(value: string): [string, string] {
  const match = value.match(/^([\d\s.,]+)(.*)$/);
  return match ? [match[1], match[2]] : [value, ''];
}

/**
 * Telegram KPI cards with a clear hierarchy: two featured metrics (large number + gradient
 * sparkline) lead, the rest follow as a compact stat strip with trend-coloured sparklines.
 * Δ vs the previous period comes from the channel_daily archive (reliable), falling back to
 * the post-window sum; sparse data → null → no pill, never a made-up number.
 */
export function KpiGrid() {
  // Legacy aggregate («Показатели»): the Overview no longer renders this — the redesigned Overview
  // splits it into independent cards — but personal Home layouts pinned under the legacy `kpi` key
  // still render it verbatim (components/legacyAdapters → LEGACY_RENDER.kpi). Keep it working.
  const { derived, isPending, isError, error } = useTgKpis();
  const navigate = useNavigate();
  const openMetric = (key: DrillKey) => navigate(`/metrics/${key}`);

  if (isPending) return <KpiSkeletons />;
  if (isError) {
    return <ErrorState title="Не удалось загрузить метрики" reason={error instanceof Error ? error.message : 'ошибка'} />;
  }

  const {
    displayMembers, channelViews, totalReactions, avgViews, er,
    subscriberTrend, viewsTrend, reactionsTrend, erTrend, avgReachTrend,
    viewsSpark, periodLabel, viewsCaption, subDelta, reactionsDelta, erCaption,
  } = derived;
  return (
    <div className="space-y-5">
      {/* HERO — primary metric: big number + area sparkline (Figma Overview lead). */}
      <FeaturedKpi
        label={`Просмотры · ${periodLabel}`}
        value={fmt.kpi(channelViews)}
        trend={viewsTrend}
        caption={viewsCaption}
        spark={viewsSpark}
        info={getDrillMetric('views')}
        onDrill={() => openMetric('views')}
      />
      {/* LEDGER — secondary metrics (Подписчики / Ср.охват / Реакции / ER). Separated by SPACING,
          not a hairline grid: the card border already frames them, so inner dividers just read as
          "lines within lines" (technical). One quiet top hairline splits ledger from the hero. */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-4 lg:grid-cols-4">
        <StatTile label="Подписчики" value={fmt.kpi(displayMembers)} trend={subscriberTrend} deltaText={subDelta} info={getDrillMetric('subscribers')} onDrill={() => openMetric('subscribers')} />
        <StatTile label="Ср. охват" value={fmt.kpi(avgViews)} trend={avgReachTrend} info={getDrillMetric('avgReach')} onDrill={() => openMetric('avgReach')} />
        <StatTile label="Реакции" value={fmt.kpi(totalReactions)} trend={reactionsTrend} deltaText={reactionsDelta} info={getDrillMetric('reactions')} onDrill={() => openMetric('reactions')} />
        <StatTile
          label="Вовлечённость"
          value={er > 0 ? fmt.pctAbs(er) : '—'}
          trend={erTrend}
          deltaText={erCaption}
          info={getDrillMetric('er')}
          onDrill={() => openMetric('er')}
        />
      </div>
    </div>
  );
}

/**
 * «Просмотры» — the redesigned Overview's primary TG time series (half width). Channel views over
 * the period as an area sparkline + the paired-window Δ. Keeps the exact «Просмотры · N дн.»
 * headline the old hero carried, so the shared period reads the same everywhere. (The three
 * compact TG cards below carry their own active-window publication-date sparklines — see
 * TgTrendStat.)
 */
export function TgViewsBody({ state, viz }: { state: TgKpiState; viz?: 'line' | 'bar' }) {
  const { derived, isPending, isError, error } = state;
  const navigate = useNavigate();
  // На ленте окно уже стоит полосой в шапке страницы — повтор в подписи только шумит (владелец).
  // На Главной страничного периода нет, там подпись остаётся единственным ответом «за что число».
  const showPeriod = useCardShowsPeriod();
  if (isPending) return <ViewsSkeleton />;
  if (isError) {
    return <ErrorState title="Не удалось загрузить метрики" reason={error instanceof Error ? error.message : 'ошибка'} />;
  }
  const { channelViews, viewsTrend, viewsCaption, viewsSpark, periodLabel } = derived;
  return (
    <FeaturedKpi
      label={showPeriod ? `Просмотры · ${periodLabel}` : 'Просмотры'}
      // Без периода подпись схлопывается в голое «Просмотры» — дубль заголовка карточки. Текст
      // уходит в sr-only (имя для скринридера остаётся), слот держит ⓘ на прежнем месте.
      labelHidden={!showPeriod}
      value={fmt.kpi(channelViews)}
      trend={viewsTrend}
      caption={viewsCaption}
      spark={viewsSpark}
      viz={viz}
      info={getDrillMetric('views')}
      onDrill={() => navigate('/metrics/views')}
    />
  );
}

/** «Ср. охват» — average views per post; the active-window publication-date sparkline below. */
export function TgAvgReachBody({ state, viz }: { state: TgKpiState; viz?: 'line' | 'bar' }) {
  const { derived, isPending, isError } = state;
  const navigate = useNavigate();
  if (isPending) return <CompactSkeleton />;
  if (isError) return <ErrorState title="Не удалось загрузить" reason="ошибка" />;
  const { avgViews, avgReachTrend, avgReachSpark, normPosts } = derived;
  return (
    <TgTrendStat
      value={avgViews}
      delta={avgReachTrend}
      spark={avgReachSpark}
      viz={viz}
      format={(n) => fmt.short(Math.round(n))}
      hasValue={normPosts.length > 0}
      onDrill={() => navigate('/metrics/avgReach')}
      drillLabel="Ср. охват"
    />
  );
}

/** «Реакции» — total reactions; the active-window publication-date sparkline below. */
export function TgReactionsBody({ state, viz }: { state: TgKpiState; viz?: 'line' | 'bar' }) {
  const { derived, isPending, isError } = state;
  const navigate = useNavigate();
  if (isPending) return <CompactSkeleton />;
  if (isError) return <ErrorState title="Не удалось загрузить" reason="ошибка" />;
  const { totalReactions, reactionsTrend, reactionsSpark, normPosts } = derived;
  return (
    <TgTrendStat
      value={totalReactions}
      delta={reactionsTrend}
      spark={reactionsSpark}
      viz={viz}
      format={(n) => fmt.short(Math.round(n))}
      hasValue={normPosts.length > 0}
      onDrill={() => navigate('/metrics/reactions')}
      drillLabel="Реакции"
    />
  );
}

/** «Вовлечённость» — ER по центру карточки (референс владельца, 2026-08-14: центрированный
    процент, под ним сравнение с прошлым периодом). */
export function TgErBody({ state }: { state: TgKpiState }) {
  const { derived, isPending, isError } = state;
  const navigate = useNavigate();
  if (isPending) return <CompactSkeleton />;
  if (isError) return <ErrorState title="Не удалось загрузить" reason="ошибка" />;
  const { er, erTrend, erCaption, members, normPosts } = derived;
  const live = members > 0 && normPosts.length > 0 && er != null && Number.isFinite(er);
  // БЕЗ искры. ER — это вовлечение, делённое на аудиторию, а аудитория за окно меняется на
  // проценты, тогда как вовлечение — в десятки раз. Значит нормализованная по min–max кривая ER
  // повторяет кривую «Реакций» почти в точности (замерено на проде: корреляция 0.996 при
  // расхождении форм 5.4% высоты плота — меньше двух пикселей на искре 200×32). Соседняя карточка
  // уже показывает эту форму. Дельта — в честных «п.п.» (erCaption), не в относительных процентах.
  return (
    <CenteredStat
      text={live ? fmt.pctAbs(er as number) : '—'}
      delta={erTrend}
      deltaText={erCaption}
      onDrill={() => navigate('/metrics/er')}
      drillLabel="Вовлечённость"
      live={live}
      note={
        <>
          Реакции, репосты и комментарии к постам периода — к текущей базе подписчиков.
          {live && normPosts.length > 0 ? ` По ${normPosts.length} публикациям.` : ''}
        </>
      }
    />
  );
}

/**
 * Compact TG comparison body (Ср. охват / Реакции / Вовлечённость): the headline (number + honest
 * delta) over an HONEST active-window sparkline keyed by UTC publication day. Owner override
 * (2026-07): these third-width TG cards now carry a publication-date timeline instead of the old
 * current/previous bars — the chart depends ONLY on the active window, never on previous-window
 * coverage. ≥2 publication-day buckets draw it (caption «по датам публикаций»); fewer keep the
 * headline and say so. NOT shared with Instagram — its CompareStat cards are untouched.
 */
/**
 * `viz` — то, что кормит «Линия»/«Столбцы» в редакторе карточки. Переключатель типа графика на
 * карточках фида это НЕ отдельный контрол: `EditWidgetDialog` уже показывает VariantCarousel, как
 * только карточка объявит два варианта, — до сих пор эти KPI-карточки не объявляли ни одного, и
 * карусели нечего было показывать (владелец: «не любой график можно настроить на bar или line»).
 * Анатомия карточки при смене не едет: меняется только примитив под хедлайном.
 */
function TgTrendStat({
  value,
  delta,
  spark,
  format,
  onDrill,
  drillLabel,
  hasValue = true,
  viz = 'line',
}: {
  value: number | null;
  delta?: MetricDelta | null;
  spark: DailySeries;
  format: (n: number) => string;
  onDrill?: () => void;
  drillLabel?: string;
  hasValue?: boolean;
  viz?: 'line' | 'bar';
}) {
  const live = hasValue && value != null && Number.isFinite(value);
  const hasChart = live && spark.values.length >= 2;
  return (
    <div className="flex h-full min-h-0 flex-col justify-between gap-4">
      <CompactStatHeadline
        text={live ? format(value as number) : '—'}
        delta={delta}
        onDrill={onDrill}
        drillLabel={drillLabel}
        live={live}
      />
      {hasChart && viz === 'bar' ? (
        <ChartBand>
          <BarChart
            values={spark.values}
            labels={spark.labels}
            axisLabels={spark.axisLabels}
            // Тултип столбца несёт ту же пару «дата · значение», что ховер-тултип искры.
            titles={spark.values.map((v, i) => `${spark.labels[i] ?? ''}: ${format(v)}`)}
            formatValue={format}
          />
        </ChartBand>
      ) : hasChart ? (
        <Sparkline
          values={spark.values}
          labels={spark.labels}
          axisLabels={spark.axisLabels}
          area
          strokeWidth={2}
          interactive
          // caption="" — резервирует строку оси; ховер-детали несёт плавающий тултип, idle-подпись
          // «по датам публикаций» убрана (владелец: лишняя строка на лице карточки).
          caption=""
          formatValue={format}
          className="h-full min-h-14 w-full"
        />
      ) : (
        <p className="text-2xs text-muted-foreground">Недостаточно дат публикаций для графика.</p>
      )}
    </div>
  );
}

/** Hero-shaped skeleton for the views card (number block left, chart area right). */
function ViewsSkeleton() {
  return (
    <div className="flex h-full items-end gap-4">
      <div className="shrink-0">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="mt-2 h-11 w-40" />
      </div>
      <Skeleton className="h-full min-h-28 min-w-0 flex-1" />
    </div>
  );
}

interface FeaturedKpiProps {
  label: string;
  /** Подпись остаётся только для AT (визуально скрыта) — когда она дублирует заголовок карточки. */
  labelHidden?: boolean;
  value: string;
  trend?: MetricDelta | null;
  caption?: string | null;
  spark?: DailySeries;
  info?: MetricDef;
  onDrill?: () => void;
  /** «Линия» / «Столбцы» из карусели вариантов карточки — см. TgTrendStat. */
  viz?: 'line' | 'bar';
}

/** Hero KPI — the steep card anatomy (owner rule): label + big number + comparison pinned
    bottom-LEFT, the area sparkline filling the width to the RIGHT of the number block. The ledger
    below is untouched — the hero zone just turned horizontal. */
function FeaturedKpi({ label, labelHidden = false, value, trend, caption, spark, info, onDrill, viz = 'line' }: FeaturedKpiProps) {
  // Кап длинной серии перед рендером (канон CLAUDE.md): на окне «Всё» архивный viewsSpark несёт
  // до 730 дневных точек — в 200×32-спарклайне это суб-пиксельная мазня. Пары {value,label}
  // прореживаются ВМЕСТЕ, чтобы hover-читалка называла именно отобранные LTTB точки; хедлайн,
  // дельта и caption считаются от полного окна в deriveKpis и капом не затрагиваются.
  const sparkShown = useMemo(() => {
    if (!spark || spark.values.length <= CHART_MAX_POINTS) return spark;
    const rows = spark.values.map((value, i) => ({ value, label: spark.labels[i] ?? '' }));
    const sampled = lttbDownsample(rows, CHART_MAX_POINTS, (r) => r.value);
    return { labels: sampled.map((r) => r.label), values: sampled.map((r) => r.value) };
  }, [spark]);
  return (
    <ChartCardBody
      hero
      label={
        <span className="flex items-center gap-1">
          {/* sr-only абсолютно спозиционирован — из flex-потока выпадает, gap перед ⓘ не растёт. */}
          <span className={labelHidden ? 'sr-only' : undefined}>{label}</span>
          {/* При скрытой подписи ⓘ переезжает к числу (valueAdornment) — одна в пустой строке
              над числом она читалась как случайный артефакт. */}
          {info && !labelHidden && <MetricInfo def={info} />}
        </span>
      }
      valueAdornment={info && labelHidden ? <MetricInfo def={info} /> : undefined}
      value={value}
      delta={trend}
      caption={caption ?? undefined}
      onValueClick={onDrill}
      drillLabel={label}
    >
      {sparkShown && sparkShown.values.length > 1 && viz === 'bar' ? (
        <div className="min-h-28 w-full flex-1">
          <BarChart
            values={sparkShown.values}
            labels={sparkShown.labels}
            axisLabels={sparkShown.axisLabels}
            titles={sparkShown.values.map((v, i) => `${sparkShown.labels[i] ?? ''}: ${fmt.num(v)}`)}
            formatValue={fmt.num}
          />
        </div>
      ) : sparkShown && sparkShown.values.length > 1 ? (
        <Sparkline
          values={sparkShown.values}
          labels={sparkShown.labels}
          axisLabels={sparkShown.axisLabels}
          area
          strokeWidth={2}
          interactive
          // caption="" включает зарезервированную строку под графиком: в покое там ось X, при
          // наведении — читалка «дата · значение · Δ». Без пропа строки нет вовсе, и этот герой
          // был единственной интерактивной искрой в продукте БЕЗ читалки — паритет с IG-твином
          // KpiHero и компактными карточками восстановлен заодно.
          caption=""
          formatValue={fmt.num}
          className="h-full min-h-28 w-full"
        />
      ) : (
        // Честное пустое состояние (канон п.8): молчаливый null оставлял пустую полосу без
        // объяснения — соседние компакт-карточки (TgTrendStat) говорят то же словами.
        <p className="self-center text-2xs text-muted-foreground">Недостаточно дней для графика.</p>
      )}
    </ChartCardBody>
  );
}

/** The KPI number — a real button (keyboard-accessible drill trigger) when onDrill is set. */
function DrillValue({
  label,
  onDrill,
  className,
  children,
}: {
  label: string;
  onDrill?: () => void;
  className: string;
  children: ReactNode;
}) {
  if (!onDrill) return <div className={className}>{children}</div>;
  return (
    <button
      type="button"
      aria-label={`Разбор: ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        onDrill();
      }}
      className={cn(
        'rounded text-left transition-colors hover:text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40',
        className,
      )}
    >
      {children}
    </button>
  );
}

interface StatTileProps {
  label: string;
  value: string;
  trend?: MetricDelta | null;
  /** Short inline delta (signed-absolute / п.п.); falls back to the percent pill when omitted. */
  deltaText?: string | null;
  info?: MetricDef;
  onDrill?: () => void;
}

/**
 * One ledger cell (no card — a hairline-delimited column in the StatTile grid). The grid's
 * gap-px over a bg-border container draws the 1px dividers; the cell sits on the paper canvas.
 */
function StatTile({ label, value, trend, deltaText, info, onDrill }: StatTileProps) {
  const [num, unit] = splitUnit(value);
  // No per-cell background/border now — cells separate by grid SPACING. A drillable cell gets a
  // quiet rounded hover surface; vertical-only padding so it never widens the grid (a horizontal
  // negative-margin bleed overflowed the card by ~12px on the edge cells).
  const cell = onDrill
    ? { onClick: onDrill, title: 'Подробный разбор', className: 'cursor-pointer rounded-md py-1 transition-colors hover:bg-muted/40' }
    : {};
  // Quiet register (steep): the ↑/↓ arrow carries direction, the colour stays muted.
  const deltaColor = 'text-muted-foreground';
  return (
    <div {...cell}>
      <div className="flex items-center gap-1 text-2xs tracking-wide text-muted-foreground">
        <span className="truncate">{label}</span>
        {info && <MetricInfo def={info} />}
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <DrillValue label={label} onDrill={onDrill} className="text-2xl font-medium tabular-nums tracking-tight">
          <ValueSwap swapKey={value}>
            {num}
            {unit ? <span className="text-base font-medium text-muted-foreground">{unit}</span> : null}
          </ValueSwap>
        </DrillValue>
        {deltaText ? (
          <span className={cn('shrink-0 text-xs font-medium tabular-nums', deltaColor)}>{deltaText}</span>
        ) : (
          <DeltaPill delta={trend} />
        )}
      </div>
    </div>
  );
}

function KpiSkeletons() {
  // Mirror the real render exactly — hero + hairline ledger — so nothing reflows or swaps
  // "card → ledger" when the data lands (the load flash the audit flagged).
  return (
    <div className="space-y-5">
      {/* HERO — the steep anatomy: number block bottom-left, chart area right. */}
      <div className="flex items-end gap-4">
        <div className="shrink-0">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="mt-2 h-11 w-40" />
        </div>
        <Skeleton className="h-28 min-w-0 flex-1" />
      </div>
      {/* LEDGER — same scaffold (border-t + spacing) as the live grid, so nothing reflows on load. */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i}>
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="mt-2 h-6 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}
