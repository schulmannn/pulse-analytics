import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fmt } from '@/lib/format';
import type { MetricDelta } from '@/lib/delta';
import { DeltaPill } from '@/components/DeltaPill';
import { LineChart } from '@/components/LineChart';
import { ChartSection as WidgetChartSection } from '@/components/ChartWidget';
import type { ChartExpandConfig } from '@/components/ExpandableChart';
import { fmtDay, type Point } from '@/lib/igMetrics';

/** Window an IG daily-Point series to the last `days` points (0 = «Всё») for the rich-expand
    overlay — feeds renderExpanded / renderExpandedBar / statsFor. Drops any 'total' marker point
    and never fabricates: a shorter series returns all it has. */
export function windowIgSeries(series: Point[], days: number, unit: string) {
  const pts = series.filter((p) => p.day !== 'total');
  const n = days === 0 ? pts.length : Math.min(days, pts.length);
  const w = pts.slice(-n);
  return {
    values: w.map((p) => p.value),
    // FULL per-point labels (not pickLabels' 3) — LineChart picks first/mid/last itself, and
    // BarChart needs one label per bar to stride; the 3-label form mislabels the bars.
    labels: w.map((p) => fmtDay(p.day)),
    titles: w.map((p) => `${fmtDay(p.day)}: ${fmt.num(p.value)} ${unit}`),
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
  return <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Нет данных за период</div>;
}

/** Signed integer with a typographic minus, e.g. +595 / −23 / 0. */
export const signedNum = (n: number): string => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt.num(Math.abs(n))}`;

export interface KpiCardProps {
  label: string;
  value: string;
  hint?: string;
  feature?: boolean;
  trend?: MetricDelta | null;
  /** A pre-formatted inline delta (e.g. "−23"); shown instead of the percent pill when set. */
  deltaText?: string;
  deltaTone?: 'up' | 'down' | 'flat';
  /** Drill to the metric's page — the number becomes a real button (TG StatTile parity). */
  onDrill?: () => void;
}

/** A single ledger cell — label, big number, optional delta + hint. Sits in a `gap-px` grid. */
export function KpiCard({ label, value, hint, feature, trend, deltaText, deltaTone, onDrill }: KpiCardProps) {
  const deltaColor =
    deltaTone === 'up' ? 'text-verdant' : deltaTone === 'down' ? 'text-ember' : 'text-muted-foreground';
  return (
    <div className={`bg-background p-4${feature ? ' ring-1 ring-inset ring-primary/40' : ''}`}>
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
      height={96}
      emphasizeLastLabel
    />
  );
  return (
    <div className="bg-background p-4">
      <div className="text-xs tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1.5 flex flex-wrap items-end gap-x-3 gap-y-1">
        <div className="kpi-accent text-[2.75rem] font-medium leading-none tabular-nums tracking-tight">{value}</div>
        <DeltaPill delta={delta} />
      </div>
      {chart &&
        (drillTo ? (
          <div className="relative mt-4">
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
            <div className="cursor-pointer" onClick={() => navigate(drillTo)}>
              {chart}
            </div>
          </div>
        ) : (
          <div className="mt-4">{chart}</div>
        ))}
    </div>
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
    Renders as a WIDGET card (chart surfaces are widgets now); the flat ChartSection above
    stays exported for non-chart hosts (metric-page rail, the report document). The chart rides
    the widget's fill context as a VARIANT (not bare children) so it fills the fixed tile height
    instead of sitting at its default 200 and leaving a gap / a stray scrollbar. */
export function TrendCard({ title, series, expand, drillTo }: { title: string; series: Point[]; expand?: ChartExpandConfig; drillTo?: string }) {
  if (series.length <= 1) {
    return (
      <WidgetChartSection title={title}>
        <EmptyChart />
      </WidgetChartSection>
    );
  }
  return (
    <WidgetChartSection
      title={title}
      expand={expand}
      drillTo={drillTo}
      variants={[
        {
          key: 'line',
          label: 'Линия',
          render: (
            <LineChart
              values={series.map((p) => p.value)}
              labels={pickLabels(series)}
              titles={series.map((p) => `${fmtDay(p.day)}: ${fmt.num(p.value)}`)}
              emphasizeLastLabel
            />
          ),
        },
      ]}
    />
  );
}
