import type { ReactNode } from 'react';
import { fmt } from '@/lib/format';
import type { MetricDelta } from '@/lib/delta';
import { DeltaPill } from '@/components/DeltaPill';
import { LineChart } from '@/components/LineChart';
import { ChartSection as WidgetChartSection } from '@/components/ChartWidget';
import { fmtDay, type Point } from '@/lib/igMetrics';

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
}

/** A single ledger cell — label, big number, optional delta + hint. Sits in a `gap-px` grid. */
export function KpiCard({ label, value, hint, feature, trend, deltaText, deltaTone }: KpiCardProps) {
  const deltaColor =
    deltaTone === 'up' ? 'text-verdant' : deltaTone === 'down' ? 'text-ember' : 'text-muted-foreground';
  return (
    <div className={`bg-background p-4${feature ? ' ring-1 ring-inset ring-primary/40' : ''}`}>
      <div className="text-xs tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2 flex items-center gap-2">
        <div className="text-3xl font-medium tabular-nums tracking-tight">{value}</div>
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
}: {
  label: string;
  value: string;
  delta?: MetricDelta | null;
  series?: Point[];
}) {
  const daily = (series ?? []).filter((p) => p.day !== 'total');
  return (
    <div className="bg-background p-4">
      <div className="text-xs tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1.5 flex flex-wrap items-end gap-x-3 gap-y-1">
        <div className="text-[2.75rem] font-medium leading-none tabular-nums tracking-tight">{value}</div>
        <DeltaPill delta={delta} />
      </div>
      {daily.length > 1 && (
        <div className="mt-4">
          <LineChart
            values={daily.map((p) => p.value)}
            labels={pickLabels(daily)}
            titles={daily.map((p) => `${fmtDay(p.day)}: ${fmt.num(p.value)}`)}
            height={64}
          />
        </div>
      )}
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
export function TrendCard({ title, series }: { title: string; series: Point[] }) {
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
      variants={[
        {
          key: 'line',
          label: 'Линия',
          render: (
            <LineChart
              values={series.map((p) => p.value)}
              labels={pickLabels(series)}
              titles={series.map((p) => `${fmtDay(p.day)}: ${fmt.num(p.value)}`)}
            />
          ),
        },
      ]}
    />
  );
}
