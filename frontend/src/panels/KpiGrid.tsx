import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChannels, useHistory, useTgFull } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { fmt } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Sparkline } from '@/components/Sparkline';
import { MetricInfo } from '@/components/InfoTooltip';
import { DeltaPill } from '@/components/DeltaPill';
import { Skeleton } from '@/components/ui/skeleton';
import { usePeriod } from '@/lib/period';
import type { MetricDelta } from '@/lib/delta';
import { METRIC_DEFS } from '@/lib/metricDefs';
import type { MetricDef } from '@/lib/metricDefs';
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
  const { days, range, inRange } = usePeriod();
  // isPending: канал-скоупный запрос выключен, пока канал не известен, — скелетон и там.
  const { data, isPending, isError, error } = useTgFull(days);
  const { data: history } = useHistory(730);
  const { channelId } = useSelectedChannel();
  const { data: channelsData } = useChannels();
  const navigate = useNavigate();
  const openMetric = (key: DrillKey) => navigate(`/metrics/${key}`);

  // Все пять reduce-проходов + оконная математика мемоизированы (shared deriveKpis —
  // те же числа, что на страницах метрик, поэтому заголовок и страница сходятся).
  const derived = useMemo(
    () => deriveKpis(data, history, channelsData, channelId, days, range, inRange),
    [data, history, channelsData, channelId, days, range, inRange],
  );

  if (isPending) return <KpiSkeletons />;
  if (isError) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Не удалось загрузить метрики: {error instanceof Error ? error.message : 'ошибка'}
        </CardContent>
      </Card>
    );
  }

  const {
    displayMembers, totalViews, totalReactions, avgViews, er,
    subscriberTrend, viewsTrend, reactionsTrend, erTrend, avgReachTrend,
    viewsSpark, periodLabel, viewsCaption, subDelta, reactionsDelta, erCaption,
  } = derived;
  return (
    <div className="space-y-5">
      {/* HERO — primary metric: big number + area sparkline (Figma Overview lead). */}
      <FeaturedKpi
        label={`Просмотры · ${periodLabel}`}
        value={fmt.short(totalViews)}
        trend={viewsTrend}
        caption={viewsCaption}
        spark={viewsSpark}
        info={METRIC_DEFS.views}
        onDrill={() => openMetric('views')}
      />
      {/* LEDGER — secondary metrics as hairline columns (Figma: Подписчики / Ср.охват / Реакции / ER).
          Clean cells: label + value + one inline delta (no per-cell sparkline, no caption line). */}
      <div className="grid grid-cols-2 gap-px border-t border-border bg-border lg:grid-cols-4">
        <StatTile label="Подписчики" value={fmt.num(displayMembers)} trend={subscriberTrend} deltaText={subDelta} info={METRIC_DEFS.subscribers} onDrill={() => openMetric('subscribers')} />
        <StatTile label="Ср. охват" value={fmt.short(avgViews)} trend={avgReachTrend} info={METRIC_DEFS.avgReach} onDrill={() => openMetric('avgReach')} />
        <StatTile label="Реакции" value={fmt.short(totalReactions)} trend={reactionsTrend} deltaText={reactionsDelta} info={METRIC_DEFS.reactions} onDrill={() => openMetric('reactions')} />
        <StatTile
          label="Вовлечённость"
          value={er > 0 ? er.toFixed(2) + '%' : '—'}
          trend={erTrend}
          deltaText={erCaption}
          info={METRIC_DEFS.er}
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

/** Hero KPI — the primary metric on the canvas (no card): big number + delta + area sparkline. */
function FeaturedKpi({ label, value, trend, caption, spark, info, onDrill }: FeaturedKpiProps) {
  const [num, unit] = splitUnit(value);
  return (
    <div>
      <div className="flex items-center gap-1 text-xs tracking-wide text-muted-foreground">
        <span>{label}</span>
        {info && <MetricInfo def={info} />}
      </div>
      {/* Number + delta, then the sparkline as a strip BELOW it (capped width, left-aligned) — same
          shape as the Instagram hero. The old side-by-side layout pushed the chart to the far right
          on wide screens (justify-between), leaving it visually unanchored. */}
      <div className="mt-2 flex items-baseline gap-2.5">
        <DrillValue label={label} onDrill={onDrill} className="text-hero font-medium leading-none tabular-nums tracking-tight">
          {num}
          {unit ? <span className="text-2xl font-medium text-muted-foreground">{unit}</span> : null}
        </DrillValue>
        <DeltaPill delta={trend} />
      </div>
      {caption ? <div className="mt-2 text-xs text-muted-foreground">{caption}</div> : null}
      {spark && spark.values.length > 1 ? (
        <div className="mt-4 max-w-2xl">
          <Sparkline
            values={spark.values}
            labels={spark.labels}
            area
            strokeWidth={2}
            interactive
            caption="по дням"
            formatValue={fmt.short}
            className="h-16 w-full"
          />
        </div>
      ) : null}
    </div>
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
  const cell = onDrill
    ? { onClick: onDrill, title: 'Подробный разбор', className: 'cursor-pointer bg-background p-4 transition-colors hover:bg-muted/60' }
    : { className: 'bg-background p-4' };
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
      {/* HERO */}
      <div>
        <Skeleton className="h-3 w-28" />
        <Skeleton className="mt-2 h-11 w-40" />
        <Skeleton className="mt-4 h-16 w-full max-w-2xl" />
      </div>
      {/* LEDGER — same scaffold (border-t / gap-px / bg-border cells on paper) as the live grid */}
      <div className="grid grid-cols-2 gap-px border-t border-border bg-border lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-background p-4">
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="mt-2 h-6 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}
