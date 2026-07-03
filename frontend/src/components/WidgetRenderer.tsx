import { DeltaPill } from '@/components/DeltaPill';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { PieChart } from '@/components/PieChart';
import { Breakdown } from '@/components/Breakdown';
import { WidgetTargetContext } from '@/components/ExpandableChart';
import type { WidgetResult } from '@/lib/resolveWidgetMetric';
import type { WidgetViz } from '@/lib/widgetMetrics';
import { breakdownTitles, effectiveViz, seriesStats, seriesToChart } from '@/lib/widgetRender';

/**
 * The single widget renderer — a WidgetResult + a chosen visualisation → the story-card BODY
 * (the ChartSection around it supplies the title / menu chrome). It reads ONLY a WidgetResult and
 * never touches a raw TG/IG payload, so every metric — Telegram or Instagram, series or breakdown —
 * gets the same presentation and polish from one place.
 *
 * Story-card anatomy (steep): a hero value + delta + caption reads the metric at a glance, then the
 * chart underneath tells the shape — so even a line chart answers «Просмотры / 388 / +12%» in a
 * second, not just «a wiggly line». Charts fill the tile via the height context the card provides.
 */
export function WidgetRenderer({ result, viz }: { result: WidgetResult; viz: WidgetViz }) {
  if (result.empty) {
    return (
      <div className="flex h-full min-h-[6rem] items-center justify-center text-sm text-muted-foreground">
        Нет данных за период
      </div>
    );
  }

  const hasSeries = !!result.series?.length;
  const hasBreakdown = !!result.breakdown?.length;
  const hasValue = result.value != null;
  const eff = effectiveViz(viz, hasSeries, hasBreakdown);

  // The hero belongs to value/series stories (a headline number). A pure breakdown card leads with
  // its chart — its «hero» is the distribution itself, and the card title names it.
  const showHero = hasValue && (eff === 'kpi' || eff === 'line' || eff === 'bar');

  // «N% от цели» (steep) — when a target is set and the metric has a scalar to measure against it.
  const targetPct = result.targetPct;
  const progress =
    targetPct != null && Number.isFinite(targetPct) ? `${Math.round(targetPct)}% от цели` : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {showHero && (
        <div className="shrink-0">
          <div className="flex items-baseline gap-2.5">
            <span className="text-2xl font-medium leading-none tabular-nums tracking-tight text-foreground">
              {result.value}
            </span>
            <DeltaPill delta={result.delta} />
          </div>
          {(result.caption || progress) && (
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
              {result.caption ? <span>{result.caption}</span> : null}
              {progress ? <span className="font-medium text-primary">{progress}</span> : null}
            </div>
          )}
        </div>
      )}
      {/* The chart's goal line reads the target from this context (config-widget: resolver-computed). */}
      <WidgetTargetContext.Provider value={result.target ?? null}>
        <div className={`min-h-0 flex-1 ${showHero ? 'mt-3' : ''}`}>
          <WidgetChart result={result} eff={eff} />
        </div>
      </WidgetTargetContext.Provider>
      <SeriesStatsFooter result={result} eff={eff} />
    </div>
  );
}

/** Compact «Макс · Среднее» footer under a series chart (S12) — the ledger density that lets a line
 *  read as numbers too. Hairline-topped, shrink-0 so it never squeezes the chart. */
function SeriesStatsFooter({ result, eff }: { result: WidgetResult; eff: WidgetViz }) {
  if (eff !== 'line' && eff !== 'bar') return null;
  const stats = seriesStats(result);
  if (stats.length === 0) return null;
  return (
    <div className="mt-2 flex shrink-0 flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-border pt-2">
      {stats.map((s) => (
        <span key={s.label} className="text-2xs text-muted-foreground">
          {s.label} <span className="font-medium tabular-nums text-foreground">{s.value}</span>
        </span>
      ))}
    </div>
  );
}

/** The chart region — picks a primitive by the effective viz and feeds it the adapted data. Charts
 *  read their height from the card's ExpandedChartHeightContext, so no explicit height here. */
function WidgetChart({ result, eff }: { result: WidgetResult; eff: WidgetViz }) {
  if (eff === 'line') {
    const c = seriesToChart(result);
    return (
      <LineChart
        values={c.values}
        labels={c.labels}
        titles={c.titles}
        ghost={result.ghost}
        ghostLabel={result.ghostLabel}
        markExtremes={c.values.length > 1}
        showPoints={c.values.length > 1 && c.values.length <= 45}
      />
    );
  }
  if (eff === 'bar') {
    const c = seriesToChart(result);
    return <BarChart values={c.values} labels={c.labels} titles={c.titles} ghost={result.ghost} ghostLabel={result.ghostLabel} />;
  }
  if (eff === 'donut') {
    const items = result.breakdown ?? [];
    return (
      <PieChart
        values={items.map((i) => i.value)}
        labels={items.map((i) => i.label)}
        titles={breakdownTitles(result)}
        colors={items.map((i) => i.color)}
      />
    );
  }
  if (eff === 'list') {
    return <Breakdown items={result.breakdown ?? []} />;
  }
  // kpi — the hero already carries the number; a series (if any) becomes a compact sparkline beneath.
  if (result.series?.length) {
    const c = seriesToChart(result);
    return <LineChart values={c.values} labels={c.labels} titles={c.titles} height={64} />;
  }
  return null;
}
