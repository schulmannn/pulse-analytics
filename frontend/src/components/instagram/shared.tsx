import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fmt } from '@/lib/format';
import { pctDelta, type MetricDelta } from '@/lib/delta';
import { DeltaPill } from '@/components/DeltaPill';
import { EmptyState } from '@/components/EmptyState';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { ChartCardBody, ChartSection as WidgetChartSection, type WidgetSize } from '@/components/ChartWidget';
import { fmtDay, pairDelta, type Point, type WindowPair } from '@/lib/igMetrics';
import type { WidgetPeriodValue } from '@/lib/period';
import type { IgData } from '@/lib/useIgData';

/** Window an IG daily-Point series to the last `days` points (0 = «Всё») for the rich-expand
    overlay — feeds renderExpanded / renderExpandedBar / statsFor. Drops any 'total' marker point
    and never fabricates: a shorter series returns all it has. */
export function windowIgSeries(series: Point[], days: number, unit: string) {
  const pts = series.filter((p) => p.day !== 'total');
  const n = days === 0 ? pts.length : Math.min(days, pts.length);
  const w = pts.slice(-n);
  // Steep headline: window total + the previous same-length window (null when «Всё» or the
  // archive is shorter than two windows — an honest comparison or none).
  const total = w.reduce((acc, p) => acc + p.value, 0);
  const prevSlice = days === 0 || pts.length < 2 * n ? null : pts.slice(-2 * n, -n);
  const prevTotal = prevSlice ? prevSlice.reduce((acc, p) => acc + p.value, 0) : null;
  return {
    values: w.map((p) => p.value),
    // FULL per-point labels (not pickLabels' 3) — LineChart picks first/mid/last itself, and
    // BarChart needs one label per bar to stride; the 3-label form mislabels the bars.
    labels: w.map((p) => fmtDay(p.day)),
    titles: w.map((p) => `${fmtDay(p.day)}: ${fmt.num(p.value)} ${unit}`),
    total,
    prevTotal,
  };
}

/** A top-level view section — an h2 heading with an optional right-aligned action. */
export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-medium tracking-tight text-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Hairline-delimited section (no card) — a small caption with a 1px rule + the body. */
export function ChartSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-3 text-xs font-medium tracking-wider text-muted-foreground">
        <span className="whitespace-nowrap">{title}</span>
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
      </h3>
      {children}
    </section>
  );
}

export function EmptyChart() {
  return <EmptyState compact title="Нет данных за период" className="h-40" />;
}

/** Signed integer with a typographic minus, e.g. +595 / −23 / 0. */
export const signedNum = (n: number): string => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt.num(Math.abs(n))}`;

export interface KpiCardProps {
  label: string;
  value: string;
  hint?: string;
  trend?: MetricDelta | null;
  /** A pre-formatted inline delta (e.g. "−23"); shown instead of the percent pill when set. */
  deltaText?: string;
  deltaTone?: 'up' | 'down' | 'flat';
  /** Drill to the metric's page — the number becomes a real button (TG StatTile parity). */
  onDrill?: () => void;
}

/** A single ledger cell — label, big number, optional delta + hint. BARE (no plate): ledgers are
    separated by SPACING in a plain grid, not a `gap-px` hairline mesh — the surrounding card
    already frames them, and a bg-background plate inside a card read as a sharp-cornered inset
    box (owner report on the IG «Показатели» hero; the TG KpiGrid rule). */
export function KpiCard({ label, value, hint, trend, deltaText, deltaTone, onDrill }: KpiCardProps) {
  const deltaColor =
    deltaTone === 'up' ? 'text-verdant' : deltaTone === 'down' ? 'text-ember' : 'text-muted-foreground';
  return (
    <div className="py-1">
      <div className="text-xs tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2 flex items-center gap-2">
        {onDrill ? (
          <button
            type="button"
            aria-label={`Разбор: ${label}`}
            title="Подробный разбор"
            onClick={onDrill}
            className="rounded text-left text-3xl font-medium tabular-nums tracking-tight transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {value}
          </button>
        ) : (
          <div className="text-3xl font-medium tabular-nums tracking-tight">{value}</div>
        )}
        {deltaText ? (
          <span className={`shrink-0 text-xs font-medium tabular-nums ${deltaColor}`}>{deltaText}</span>
        ) : (
          <DeltaPill delta={trend} />
        )}
      </div>
      {hint ? <div className="mt-2 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

/** The lead KPI — a large number + delta and (only for a metric with a real daily series) a small
    area chart. Used for Охват on the Overview, since reach is one of the few honest daily series. */
export function KpiHero({
  label,
  value,
  delta,
  series,
  drillTo,
}: {
  label: string;
  value: string;
  delta?: MetricDelta | null;
  series?: Point[];
  /** Route of the metric's explorer page (/metrics/ig-*). The ↗ Link is the semantic
      (keyboard/AT) path; the whole chart block is a mouse convenience — the same drill
      contract as widget cards, so the hero chart is never a dead end. */
  drillTo?: string;
}) {
  const navigate = useNavigate();
  const daily = (series ?? []).filter((p) => p.day !== 'total');
  const chart = daily.length > 1 && (
    <LineChart
      values={daily.map((p) => p.value)}
      labels={pickLabels(daily)}
      titles={daily.map((p) => `${fmtDay(p.day)}: ${fmt.num(p.value)}`)}
      height={112}
      emphasizeLastLabel
    />
  );
  // Steep anatomy (owner rule): label + number + delta bottom-left, the chart inset to the RIGHT.
  return (
    <ChartCardBody hero label={label} value={value} delta={delta} onValueClick={drillTo ? () => navigate(drillTo) : undefined}>
      {chart &&
        (drillTo ? (
          <div className="relative h-full">
            <Link
              to={drillTo}
              aria-label={`Разбор: ${label}`}
              title="Подробный разбор"
              className="absolute right-1 top-1 z-10 rounded border border-transparent p-1 text-muted-foreground transition-colors hover:border-border hover:bg-background hover:text-foreground"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M7 17 17 7M9 7h8v8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
            {/* Mouse convenience only (no button role — the ↗ Link above is the semantic path). */}
            <div className="h-full cursor-pointer" onClick={() => navigate(drillTo)}>
              {chart}
            </div>
          </div>
        ) : (
          <div className="h-full">{chart}</div>
        ))}
    </ChartCardBody>
  );
}

/** Daily gross-follows bars — the second genuine IG daily series. Same per-widget-period card
    contract as TrendCard (full series in, client-side windowing, own pills). The old «всего за
    период» caption is gone: the figure lives in «Движение подписчиков» and couldn't follow a
    per-widget window as static children. */
export function FollowsByDayCard({ data, drillTo, id, homeKey, title = 'Подписки по дням' }: { data: Point[]; drillTo?: string; id?: string; homeKey?: string; title?: string }) {
  const pts = data.filter((p) => p.day !== 'total');
  return (
    <WidgetChartSection
      id={id}
      homeKey={homeKey}
      title={title}
      drillTo={drillTo}
      periodControl
      variants={(period: WidgetPeriodValue) => {
        const w = pts.filter((p) => period.inRange(p.day));
        const total = w.reduce((acc, p) => acc + p.value, 0);
        const prev =
          period.days !== 0 && w.length > 0 && pts.length >= 2 * w.length
            ? pts.slice(-2 * w.length, -w.length).reduce((acc, p) => acc + p.value, 0)
            : null;
        const delta = prev != null && prev > 0 ? pctDelta(total, prev) : null;
        return [
          {
            key: 'bar',
            label: 'Столбцы',
            render:
              w.length > 0 ? (
                <ChartCardBody value={`+${fmt.kpi(total)}`} delta={delta} caption={delta ? 'к пред. периоду' : period.days === 0 ? 'за всё время' : undefined}>
                  <BarChart
                    values={w.map((d) => d.value)}
                    labels={w.map((d) => fmtDay(d.day))}
                    titles={w.map((d) => `${fmtDay(d.day)}: +${fmt.num(d.value)}`)}
                  />
                </ChartCardBody>
              ) : (
                <EmptyChart />
              ),
          },
        ];
      }}
    />
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="pt-2">
      <div className="text-2xs font-medium tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-medium tabular-nums">{value}</div>
    </div>
  );
}

export function pickLabels(series: Point[]): string[] {
  if (series.length === 0) return [];
  const first = series[0];
  const mid = series[Math.floor(series.length / 2)];
  const last = series[series.length - 1];
  return [first?.day ?? '', mid?.day ?? '', last?.day ?? ''].map(fmtDay);
}

/** A daily line chart for a metric that genuinely has a daily series (reach / new followers).
    Renders as a WIDGET card with its OWN period pills (periodControl): the card takes the FULL
    series and windows it client-side per the widget period — the archive-backed series is
    already longer than any window, so no per-widget insights fan-out is needed. The chart rides
    the widget's fill context as a VARIANT so it fills the fixed tile height. */
export function TrendCard({ title, series, drillTo, id, homeKey, defaultSize }: { title: string; series: Point[]; drillTo?: string; id?: string; homeKey?: string; defaultSize?: WidgetSize }) {
  const pts = series.filter((p) => p.day !== 'total');
  return (
    <WidgetChartSection
      id={id}
      homeKey={homeKey}
      title={title}
      drillTo={drillTo}
      defaultSize={defaultSize}
      periodControl
      variants={(period: WidgetPeriodValue) => {
        const w = pts.filter((p) => period.inRange(p.day));
        // Steep anatomy: the window's total + the MANDATORY comparison vs the previous
        // same-length window (honest: none on «Всё» or when the archive is too short).
        const total = w.reduce((acc, p) => acc + p.value, 0);
        const prev =
          period.days !== 0 && w.length > 0 && pts.length >= 2 * w.length
            ? pts.slice(-2 * w.length, -w.length).reduce((acc, p) => acc + p.value, 0)
            : null;
        const delta = prev != null && prev > 0 ? pctDelta(total, prev) : null;
        return [
          {
            key: 'line',
            label: 'Линия',
            render:
              w.length > 1 ? (
                <ChartCardBody value={fmt.kpi(total)} delta={delta} caption={delta ? 'к пред. периоду' : period.days === 0 ? 'за всё время' : undefined}>
                  <LineChart
                    values={w.map((p) => p.value)}
                    labels={pickLabels(w)}
                    titles={w.map((p) => `${fmtDay(p.day)}: ${fmt.num(p.value)}`)}
                    emphasizeLastLabel
                  />
                </ChartCardBody>
              ) : (
                <EmptyChart />
              ),
          },
        ];
      }}
    />
  );
}

// A whole window without a single non-zero sample is «нет данных», not a real zero — insights
// quota burn / missing metrics must read as a dash with no delta, never as a crash (D6.1).
const isLive = (p: WindowPair) => p.hasCur && p.cur > 0;

/**
 * The IG «Показатели» body — KPI hero (Охват, a real daily series) + the 4-cell ledger. BARE
 * content (no own card): the Обзор renders it inside its widget group's «Показатели» ChartSection,
 * and the Home registry pins it via the self-fetching IgKpiHomeCard — the IG twin of TG's KpiGrid.
 */
export function IgKpiBlock({ ig }: { ig: IgData }) {
  const navigate = useNavigate();
  const erTrend =
    ig.erReach > 0 && ig.pairs.reach.hasCur && ig.pairs.reach.hasPrev && ig.erReachPrev > 0
      ? pctDelta(ig.erReach, ig.erReachPrev)
      : null;
  return (
    // TG KpiGrid composition: the hero sits straight on the card and the ledger splits off with
    // ONE quiet top hairline + spacing — no inner plate, no hairline mesh (the card is the frame).
    <div className="space-y-5">
      <KpiHero
        label={`Охват · ${ig.window.days} дн.`}
        value={fmt.kpi(ig.pairs.reach.cur)}
        delta={pairDelta(ig.pairs.reach)}
        series={ig.series.reach.filter((p) => ig.inWindow(p.day))}
        drillTo="/metrics/ig-reach"
      />
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-4 lg:grid-cols-4">
        <KpiCard
          label="Подписчики"
          value={fmt.kpi(ig.followers)}
          deltaText={ig.netMovement.hasCur ? signedNum(ig.netMovement.cur) : undefined}
          deltaTone={ig.netMovement.cur > 0 ? 'up' : ig.netMovement.cur < 0 ? 'down' : 'flat'}
          onDrill={() => navigate('/metrics/ig-follows')}
        />
        <KpiCard
          label="Просмотры"
          value={isLive(ig.pairs.views) ? fmt.kpi(ig.pairs.views.cur) : '—'}
          trend={isLive(ig.pairs.views) ? pairDelta(ig.pairs.views) : null}
          onDrill={() => navigate('/metrics/ig-views')}
        />
        <KpiCard
          label="Вовлечённость"
          value={ig.erReach > 0 ? `${ig.erReach.toFixed(2)}%` : '—'}
          trend={erTrend}
          onDrill={() => navigate('/metrics/ig-er')}
        />
        <KpiCard
          label="Взаимодействия"
          value={isLive(ig.pairs.ti) ? fmt.kpi(ig.pairs.ti.cur) : '—'}
          trend={isLive(ig.pairs.ti) ? pairDelta(ig.pairs.ti) : null}
          onDrill={() => navigate('/metrics/ig-interactions')}
        />
      </div>
    </div>
  );
}
