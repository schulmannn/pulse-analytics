import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChannels, useHistory, useTgFull } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { fmt } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ErrorState } from '@/components/ErrorState';
import { Sparkline } from '@/components/Sparkline';
import { MetricInfo } from '@/components/InfoTooltip';
import { DeltaPill } from '@/components/DeltaPill';
import { Skeleton } from '@/components/ui/skeleton';
import { ChartCardBody } from '@/components/ChartWidget';
import { useWidgetPeriod } from '@/lib/period';
import type { MetricDelta } from '@/lib/delta';
import { getDrillMetric, type MetricDef } from '@/lib/widgetMetrics';
import { deriveKpis } from '@/lib/kpiDerive';
import type { DailySeries, DrillKey } from '@/lib/kpiDerive';

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
  // Per-widget window (useWidgetPeriod), not the global period. No custom range at the widget
  // level (presets only), so `range` is always null here.
  const { days, inRange } = useWidgetPeriod();
  // isPending: канал-скоупный запрос выключен, пока канал не известен, — скелетон и там.
  // Wide fetch (limit 100 = server cap): one entry shared with the sibling widgets; the window
  // is applied client-side via inRange, so a narrower widget period never spawns its own request.
  const { data, isPending, isError, error } = useTgFull(0);
  const { data: history } = useHistory(730);
  const { channelId } = useSelectedChannel();
  const { data: channelsData } = useChannels();
  const navigate = useNavigate();
  const openMetric = (key: DrillKey) => navigate(`/metrics/${key}`);

  // Все пять reduce-проходов + оконная математика мемоизированы (shared deriveKpis —
  // те же числа, что на страницах метрик, поэтому заголовок и страница сходятся).
  const derived = useMemo(
    () => deriveKpis(data, history, channelsData, channelId, days, null, inRange),
    [data, history, channelsData, channelId, days, inRange],
  );

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
          value={er > 0 ? er.toFixed(2) + '%' : '—'}
          trend={erTrend}
          deltaText={erCaption}
          info={getDrillMetric('er')}
          onDrill={() => openMetric('er')}
        />
      </div>
    </div>
  );
}

interface FeaturedKpiProps {
  label: string;
  value: string;
  trend?: MetricDelta | null;
  caption?: string | null;
  spark?: DailySeries;
  info?: MetricDef;
  onDrill?: () => void;
}

/** Hero KPI — the steep card anatomy (owner rule): label + big number + comparison pinned
    bottom-LEFT, the area sparkline filling the width to the RIGHT of the number block. The ledger
    below is untouched — the hero zone just turned horizontal. */
function FeaturedKpi({ label, value, trend, caption, spark, info, onDrill }: FeaturedKpiProps) {
  return (
    <ChartCardBody
      hero
      label={
        <span className="flex items-center gap-1">
          {label}
          {info && <MetricInfo def={info} />}
        </span>
      }
      value={value}
      delta={trend}
      caption={caption ?? undefined}
      onValueClick={onDrill}
    >
      {spark && spark.values.length > 1 ? (
        <Sparkline
          values={spark.values}
          labels={spark.labels}
          area
          strokeWidth={2}
          interactive
          caption="по дням"
          formatValue={fmt.num}
          className="h-full min-h-28 w-full"
        />
      ) : null}
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
        'rounded text-left transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
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
  const deltaColor =
    trend?.dir === 'up' ? 'text-verdant' : trend?.dir === 'down' ? 'text-ember' : 'text-muted-foreground';
  return (
    <div {...cell}>
      <div className="flex items-center gap-1 text-2xs tracking-wide text-muted-foreground">
        <span className="truncate">{label}</span>
        {info && <MetricInfo def={info} />}
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <DrillValue label={label} onDrill={onDrill} className="text-2xl font-medium tabular-nums tracking-tight">
          {num}
          {unit ? <span className="text-base font-medium text-muted-foreground">{unit}</span> : null}
        </DrillValue>
        {deltaText ? (
          <span className={cn('shrink-0 text-xs font-medium tabular-nums', deltaColor)}>{deltaText}</span>
        ) : (
          <DeltaPill delta={trend} subtle />
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
