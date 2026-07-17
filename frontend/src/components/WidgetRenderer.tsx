import { useContext, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { DeltaPill } from '@/components/DeltaPill';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { PieChart } from '@/components/PieChart';
import { Breakdown } from '@/components/Breakdown';
import { ChartExpandedContext, ExpandedChartHeightContext, WidgetTargetContext } from '@/components/ExpandableChart';
import { observeSize } from '@/lib/observeSize';
import { MetricExplainPanel, MetricExplainTooltip } from '@/components/MetricExplain';
import { Skeleton } from '@/components/ui/skeleton';
import { pluralRu } from '@/lib/resolveWidgetMetric';
import { networkDisplayName } from '@/lib/networks';
import type { WidgetMeta, WidgetResult } from '@/lib/resolveWidgetMetric';
import type { WidgetViz } from '@/lib/widgetMetrics';
import { breakdownTitles, effectiveViz, seriesStats, seriesToChart } from '@/lib/widgetRender';

/**
 * Loading placeholder shaped like the story card (hero bar + chart area), shown while the widget's
 * data queries are pending — so a config widget never flashes «Нет данных» (the empty state) before
 * its data arrives, and loading is visibly distinct from a genuinely empty result (steep #14).
 */
export function WidgetSkeleton({ viz }: { viz: WidgetViz }) {
  // Value/series vizzes lead with a hero number; breakdowns (donut/list) lead with the chart itself.
  const heroLed = viz === 'kpi' || viz === 'line' || viz === 'bar';
  return (
    <div className="flex h-full min-h-0 flex-col">
      {heroLed && (
        <div className="shrink-0 space-y-2">
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-3 w-40" />
        </div>
      )}
      <div className={`min-h-0 flex-1 ${heroLed ? 'mt-3' : ''}`}>
        <Skeleton className="h-full min-h-[72px] w-full rounded" />
      </div>
    </div>
  );
}

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
export function WidgetRenderer({
  result,
  viz,
  onDrill,
  drillLabel,
}: {
  result: WidgetResult;
  viz: WidgetViz;
  /** When set (a metric with its own page), the hero value and the chart points become a
      drilldown gesture into that page. Left unset — previews, the explorer sandbox, IG and
      breakdown metrics — the card is read-only as before. */
  onDrill?: () => void;
  /** Metric name for the drill button's accessible label (so multiple drill cards are
      distinguishable to a screen reader, matching KpiGrid's DrillValue). */
  drillLabel?: string;
}) {
  // Detail overlay / explorer set this true → show the full explain panel there; the collapsed card
  // gets the compact ⓘ instead (see the meta row below).
  const expanded = useContext(ChartExpandedContext);
  // The chart must size to ITS band, not the whole card body: the card's height context carries the
  // full body measurement (hero + chart + meta), so a hero-led card's chart rendered taller than its
  // flex band and the bottom of the plot (min-value points) was clipped by overflow-hidden
  // (владелец: «графики не вмещаются по оси Y»). Measure the band itself and override the context
  // for the chart subtree only (Breakdown self-measures; the meta/hero rows stay outside).
  const bandRef = useRef<HTMLDivElement>(null);
  const [bandH, setBandH] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = bandRef.current;
    if (!el) return;
    const measure = () => setBandH(el.clientHeight || null);
    measure();
    return observeSize(el, measure);
  }, [result.empty]);
  if (result.empty) {
    return (
      <div className="flex h-full min-h-[6rem] flex-col items-center justify-center gap-1.5 px-3 text-center">
        <svg className="h-6 w-6 text-ink3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 5v14h16" />
          <path d="M7 14h10" strokeDasharray="2 2.5" opacity="0.7" />
        </svg>
        <div className="text-sm font-medium text-foreground">Нет данных за период</div>
        <p className="text-2xs text-muted-foreground">Попробуйте другой период или источник.</p>
        {/* WHAT was empty — here the full source/window line IS the message. */}
        <WidgetMetaLine meta={result.meta} className="max-w-full" verbose />
      </div>
    );
  }

  const hasSeries = !!result.series?.length;
  const hasBreakdown = !!result.breakdown?.length;
  const hasValue = result.value != null;
  const eff = effectiveViz(viz, hasSeries, hasBreakdown, result.unit);

  // Lead with a hero headline whenever the resolver provides one — value/series metrics, and now
  // ADDITIVE breakdowns (a total, steep #4.9). A non-additive breakdown carries no value, so it
  // still leads with its chart (the distribution IS the story, and the card title names it).
  const showHero = hasValue;

  // «N% от цели» (steep) — when a target is set and the metric has a scalar to measure against it.
  const targetPct = result.targetPct;
  const progress =
    targetPct != null && Number.isFinite(targetPct) ? `${Math.round(targetPct)}% от цели` : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {showHero && (
        <div className="shrink-0">
          <div className="flex items-baseline gap-2.5">
            {onDrill ? (
              <button
                type="button"
                onClick={onDrill}
                aria-label={drillLabel ? `Разбор: ${drillLabel}` : 'Открыть страницу метрики'}
                className="rounded text-2xl font-medium leading-none tabular-nums tracking-tight text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                {result.value}
              </button>
            ) : (
              <span className="text-2xl font-medium leading-none tabular-nums tracking-tight text-foreground">
                {result.value}
              </span>
            )}
            <DeltaPill delta={result.delta} />
          </div>
          {(result.caption || progress) && (
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
              {result.caption ? <span>{result.caption}</span> : null}
              {progress ? <span className="font-medium text-muted-foreground">{progress}</span> : null}
            </div>
          )}
        </div>
      )}
      {/* The chart's goal line reads the target from this context (config-widget: resolver-computed). */}
      <WidgetTargetContext.Provider value={result.target ?? null}>
        {/* overflow-hidden: fixed-tile charts size their svg from the measured BODY height, which
            can overrun this flex-1 band and paint under the meta line / stats footer — clip the
            chart to its allotted band so the caption stays legible. */}
        <div ref={bandRef} className={`min-h-0 flex-1 overflow-hidden ${showHero ? 'mt-3' : ''}`}>
          <ExpandedChartHeightContext.Provider value={bandH}>
            <WidgetChart result={result} eff={eff} onDrill={onDrill} expanded={expanded} />
          </ExpandedChartHeightContext.Provider>
        </div>
      </WidgetTargetContext.Provider>
      {expanded ? (
        // Detail / explorer has room: the full «почему это число такое» panel (formula + source +
        // live period / sample / freshness / comparison), which subsumes the one-line meta.
        <MetricExplainPanel metricId={result.metricId} meta={result.meta} className="mt-4 border-t border-border pt-4" />
      ) : (
        // Collapsed card: the terse meta line + a compact ⓘ that opens the same explanation.
        <WidgetMetaLine
          meta={result.meta}
          className="mt-2"
          info={<MetricExplainTooltip metricId={result.metricId} meta={result.meta} />}
        />
      )}
      {/* Макс/Среднее ledger belongs to the PROOF surface — the expanded detail. On the card face
          it duplicated the hero and the chart (владелец: «слишком много текста», steep cards
          carry title + number + delta + chart, nothing else). */}
      {expanded && <SeriesStatsFooter result={result} eff={eff} />}
    </div>
  );
}

/**
 * The «source + data-quality» caption. The card face keeps the QUIET subset (steep: карточка —
 * это заголовок, число, дельта и график): period + sample when they explain the number, plus the
 * honesty segments that must not hide (stale freshness in warn tone, «сравнение скрыто — …»).
 * Identity (network · @source) lives in the card header chip / page header, and the long-form
 * quality meta (archive depth, fresh-when-fresh) in the ⓘ tooltip and the expanded panel.
 * `verbose` restores every known segment — the empty state uses it to say WHAT exactly was empty.
 * One muted truncating line, never wraps the tile.
 */
function WidgetMetaLine({ meta, className = '', info, verbose = false }: { meta?: WidgetMeta; className?: string; info?: ReactNode; verbose?: boolean }) {
  const segs: Array<{ key: string; text: string; warn?: boolean }> = [];
  if (meta) {
    // Network label reads from the registry, so a МойСклад widget says «МойСклад», not «Telegram»
    // (the old `=== 'ig' ? … : 'Telegram'` fell every non-IG network — including ms — to Telegram).
    if (verbose && meta.network) segs.push({ key: 'net', text: networkDisplayName(meta.network) });
    if (verbose && meta.sourceLabel) segs.push({ key: 'src', text: meta.sourceLabel });
    if (meta.periodLabel) segs.push({ key: 'per', text: meta.periodLabel });
    if (meta.samplePosts != null && meta.samplePosts > 0)
      segs.push({ key: 'smp', text: `${meta.samplePosts} ${pluralRu(meta.samplePosts, ['пост', 'поста', 'постов'])}` });
    if (verbose && meta.archiveDays != null && meta.archiveDays > 0)
      segs.push({ key: 'arc', text: `${meta.archiveDays} дн. в архиве` });
    if (meta.fresh && (verbose || meta.fresh.stale))
      segs.push({ key: 'fr', text: `данные: ${meta.fresh.label}`, warn: meta.fresh.stale });
    if (meta.comparisonNote) segs.push({ key: 'cmp', text: meta.comparisonNote });
  }
  // No dynamic segments, but the ⓘ may still carry the static formula/source — keep it reachable.
  if (segs.length === 0) return info ? <span className={`inline-flex shrink-0 ${className}`}>{info}</span> : null;
  // Inline spans inside one truncating <p> — a genuine single line with an ellipsis, never a wrap
  // that eats chart height (the tile is fixed; this row is shrink-0 like the stats footer). With an
  // ⓘ trailing it, the <p> flexes so the icon keeps its place while the line still truncates.
  const line = (
    <p className={info ? 'min-w-0 flex-1 truncate text-2xs text-muted-foreground' : `min-w-0 shrink-0 truncate text-2xs text-muted-foreground ${className}`}>
      {segs.map((s, i) => (
        <span key={s.key}>
          {/* Spaces stay OUTSIDE aria-hidden — hiding them with the dot glues the segments together
              for screen readers («Telegramза 30 дн.»). Only the decorative glyph is hidden. */}
          {i > 0 && (
            <>
              {' '}
              <span aria-hidden="true">·</span>{' '}
            </>
          )}
          <span className={s.warn ? 'text-status-warn' : undefined}>{s.text}</span>
        </span>
      ))}
    </p>
  );
  if (!info) return line;
  return <div className={`flex shrink-0 items-center gap-1.5 ${className}`}>{line}{info}</div>;
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
function WidgetChart({ result, eff, onDrill, expanded = false }: { result: WidgetResult; eff: WidgetViz; onDrill?: () => void; expanded?: boolean }) {
  const onPointClick = onDrill ? () => onDrill() : undefined;
  if (eff === 'line') {
    const c = seriesToChart(result);
    return (
      <LineChart
        values={c.values}
        labels={c.labels}
        titles={c.titles}
        ghost={result.ghost}
        ghostLabel={result.ghostLabel}
        // Extreme VALUE LABELS are detail-surface furniture: on the card face they double the
        // hero over a tiny sparkline (текст-шум); the expanded chart keeps them (peak label).
        markExtremes={expanded && c.values.length > 1}
        // Кольца-точки — деталь-поверхностей (метрик-страница/разворот); на карточке они были
        // единственным местом в продукте с точками на каждой дате (владелец: «нигде больше»).
        showPoints={expanded && c.values.length > 1 && c.values.length <= 45}
        onPointClick={onPointClick}
      />
    );
  }
  if (eff === 'bar') {
    const c = seriesToChart(result);
    return <BarChart values={c.values} labels={c.labels} titles={c.titles} ghost={result.ghost} ghostLabel={result.ghostLabel} onPointClick={onPointClick} />;
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
    return <LineChart values={c.values} labels={c.labels} titles={c.titles} height={64} onPointClick={onPointClick} />;
  }
  return null;
}
