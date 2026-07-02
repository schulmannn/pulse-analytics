import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useChannels, useHistory, useTgFull } from '@/api/queries';
import type { HistoryData } from '@/api/schemas';
import { useSelectedChannel } from '@/lib/channel-context';
import { usePeriod } from '@/lib/period';
import type { PeriodDays } from '@/lib/period';
import { deriveKpis, filledDailySeries, sparseDailySeries } from '@/lib/kpiDerive';
import type { DailySeries, DrillKey } from '@/lib/kpiDerive';
import { fmt } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DeltaPill } from '@/components/DeltaPill';
import { LineChart } from '@/components/LineChart';
import { ChartSection } from '@/components/instagram/shared';
import { Digest } from '@/panels/Digest';
import { Insights } from '@/panels/Insights';
import { TopPosts } from '@/panels/TopPosts';

const DAY_MS = 24 * 60 * 60 * 1000;

type HistoryRow = HistoryData['rows'][number];

/** Monday-start UTC week key for a YYYY-MM-DD day (date-only strings parse as UTC midnight). */
function mondayKey(dayISO: string): string | null {
  const t = Date.parse(dayISO);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

interface WeeklyTable {
  weeks: { key: string; label: string }[];
  rows: { label: string; signed?: boolean; values: (number | null)[] }[];
}

/**
 * Weekly rollup of the daily archive for the heat-shaded table (steep Reports' signature
 * visual): volume metrics sum per week, the subscriber row is the within-week change.
 */
function buildWeeklyTable(rows: HistoryRow[]): WeeklyTable | null {
  const byWeek = new Map<string, HistoryRow[]>();
  for (const row of rows) {
    const key = mondayKey(row.day);
    if (!key) continue;
    const bucket = byWeek.get(key);
    if (bucket) bucket.push(row);
    else byWeek.set(key, [row]);
  }
  const keys = [...byWeek.keys()].sort().slice(-6);
  if (keys.length < 2) return null;

  const sumOf = (week: HistoryRow[], pick: (r: HistoryRow) => number | null | undefined): number | null => {
    let sum = 0;
    let has = false;
    for (const r of week) {
      const v = pick(r);
      if (v == null) continue;
      sum += Number(v);
      has = true;
    }
    return has ? sum : null;
  };
  const subsDelta = (week: HistoryRow[]): number | null => {
    const subs = week
      .filter((r) => r.subscribers != null)
      .sort((a, b) => a.day.localeCompare(b.day))
      .map((r) => Number(r.subscribers));
    return subs.length >= 2 ? subs[subs.length - 1] - subs[0] : null;
  };

  const weekRows = keys.map((k) => byWeek.get(k)!);
  return {
    weeks: keys.map((k) => ({ key: k, label: fmt.day(k) })),
    rows: [
      { label: 'Просмотры', values: weekRows.map((w) => sumOf(w, (r) => r.views)) },
      { label: 'Реакции', values: weekRows.map((w) => sumOf(w, (r) => r.reactions)) },
      { label: 'Репосты', values: weekRows.map((w) => sumOf(w, (r) => r.forwards)) },
      { label: 'Подписчики, Δ', signed: true, values: weekRows.map(subsDelta) },
    ],
  };
}

/**
 * Data-driven cell shading (chart-class paint, hence inline hsl like the SVG fills): the alpha
 * ramps with the value's share of the row max — verdant for volume/growth, ember for losses.
 */
function cellTint(value: number | null, rowMax: number, signed?: boolean): React.CSSProperties | undefined {
  if (value == null || rowMax <= 0) return undefined;
  const alpha = 0.05 + 0.3 * Math.min(Math.abs(value) / rowMax, 1);
  const token = signed && value < 0 ? '--brand-ember' : '--brand-verdant';
  return { backgroundColor: `hsl(var(${token}) / ${alpha.toFixed(3)})` };
}

const PERIOD_CHIPS: Array<{ days: PeriodDays; label: string }> = [
  { days: 7, label: '7д' },
  { days: 30, label: '30д' },
  { days: 90, label: '90д' },
  { days: 0, label: 'Всё' },
];

const LEDGER: Array<{ key: DrillKey; label: string }> = [
  { key: 'views', label: 'Просмотры' },
  { key: 'subscribers', label: 'Подписчики' },
  { key: 'avgReach', label: 'Ср. охват' },
  { key: 'reactions', label: 'Реакции' },
  { key: 'forwards', label: 'Репосты' },
  { key: 'er', label: 'ER' },
];

/**
 * Отчёт — the steep-Reports adaptation (S4, the F3 base): the period as a readable document.
 * A document header + global filter bar (period / channel / platform — the same shared state
 * the topbar drives, surfaced document-style), then a summary ledger, the Insight block,
 * two metric cards, a heat-shaded weekly table, auto-insights and the top posts. «Печать /
 * PDF» prints just the document (the app shell is print-hidden) — the poor-man's export
 * until F3 brings real PDF/share.
 */
export function ReportPage() {
  const { days, setDays, range, setRange, inRange } = usePeriod();
  const { data, isPending, isError, error } = useTgFull(days, { windowPair: true });
  const { data: history } = useHistory(730);
  const { channelId, setChannelId } = useSelectedChannel();
  const { data: channelsData } = useChannels();
  const [channelOpen, setChannelOpen] = useState(false);

  const derived = useMemo(
    () => deriveKpis(data, history, channelsData, channelId, days, range, inRange),
    [data, history, channelsData, channelId, days, range, inRange],
  );

  const weekly = useMemo(() => buildWeeklyTable(history?.rows ?? []), [history]);

  if (isPending) return <ReportSkeleton />;
  if (isError) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Не удалось построить отчёт: {error instanceof Error ? error.message : 'ошибка'}
        </CardContent>
      </Card>
    );
  }

  const channels = channelsData?.channels ?? [];
  const current = channels.find((c) => c.id === channelId);
  const channelName = String(current?.username || current?.title || current?.id || '');
  const { drillMeta, normPosts, subsSpark, periodLabel } = derived;

  // Views daily series for the first metric card (same math as /metrics/views).
  const winTo = range ? range.to : Date.now();
  const winFrom = range ? range.from : days > 0 ? winTo - (days - 1) * DAY_MS : null;
  const viewsSeries: DailySeries =
    winFrom != null && (winTo - winFrom) / DAY_MS <= 366
      ? filledDailySeries(normPosts, 'reach', winFrom, winTo)
      : sparseDailySeries(normPosts, 'reach');

  const rangeLabel = range ? `${fmt.day(range.from)} – ${fmt.day(range.to)}` : null;
  // An instant renders as the viewer's local day now that fmt.day takes Date/epoch directly.
  const generated = fmt.day(new Date());

  const chipBase = 'rounded-full border px-3 py-1 text-xs font-medium transition-colors';
  const chipActive = 'border-primary/40 bg-primary/10 text-primary';
  const chipIdle = 'border-border text-muted-foreground hover:text-foreground';

  return (
    <div className="mx-auto w-full max-w-4xl space-y-10">
      {/* Document header — the report reads as an artifact, not a dashboard view. */}
      <div>
        <div className="text-xs text-muted-foreground">Отчёт · Telegram · сгенерирован {generated}</div>
        <h2 className="mt-1 text-3xl font-medium tracking-tight">
          @{channelName} — {rangeLabel ?? periodLabel}
        </h2>

        {/* Global filter bar (steep Reports): period / channel / platform pills + print. */}
        <div className="mt-4 flex flex-wrap items-center gap-2 border-y border-border py-3 print:hidden">
          {PERIOD_CHIPS.map((chip) => (
            <button
              key={chip.days}
              type="button"
              onClick={() => setDays(chip.days)}
              className={`${chipBase} ${!range && days === chip.days ? chipActive : chipIdle}`}
            >
              {chip.label}
            </button>
          ))}
          {rangeLabel && (
            <button
              type="button"
              onClick={() => setRange(null)}
              title="Сбросить произвольный период"
              className={`${chipBase} ${chipActive}`}
            >
              {rangeLabel} ×
            </button>
          )}
          <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
          {channels.length >= 2 ? (
            <div className="relative">
              <button
                type="button"
                onClick={() => setChannelOpen((v) => !v)}
                aria-expanded={channelOpen}
                className={`${chipBase} ${chipIdle}`}
              >
                @{channelName} ⌄
              </button>
              {channelOpen && (
                <div className="absolute left-0 top-full z-20 mt-1 w-52 rounded border border-border bg-card p-1">
                  {channels.map((channel) => {
                    const name = String(channel.username || channel.title || channel.id);
                    return (
                      <button
                        key={channel.id}
                        type="button"
                        onClick={() => {
                          setChannelId(channel.id);
                          setChannelOpen(false);
                        }}
                        className={`block w-full rounded px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted ${
                          channel.id === channelId ? 'text-foreground' : 'text-muted-foreground'
                        }`}
                      >
                        @{name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <span className={`${chipBase} ${chipIdle} cursor-default`}>@{channelName}</span>
          )}
          <span className={`${chipBase} ${chipIdle} cursor-default`}>Telegram</span>
          <span className="flex-1" />
          <button type="button" onClick={() => window.print()} className={`${chipBase} ${chipIdle}`}>
            Печать / PDF
          </button>
        </div>
      </div>

      {/* Сводка — the six KPIs as a hairline ledger (same numbers as the Overview). */}
      <ChartSection title="Сводка">
        <div className="grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
          {LEDGER.map(({ key, label }) => (
            <Link key={key} to={`/metrics/${key}`} className="bg-background p-3 transition-colors hover:bg-muted/60">
              <div className="text-2xs tracking-wide text-muted-foreground">{label}</div>
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className="text-xl font-medium tabular-nums tracking-tight">{drillMeta[key].total}</span>
                <DeltaPill delta={drillMeta[key].trend} subtle />
              </div>
            </Link>
          ))}
        </div>
      </ChartSection>

      {/* Инсайт — Итог / Доказательство / Что сделать (label now lives on the section). */}
      <ChartSection title="Инсайт">
        <Digest />
      </ChartSection>

      {/* Metric cards (steep's 2-up grid); each opens its metric page. */}
      <div className="grid grid-cols-1 gap-10 md:grid-cols-2">
        <ReportMetricCard
          title="Просмотры по дням"
          total={drillMeta.views.total}
          trend={drillMeta.views.trend}
          series={viewsSeries}
          valueFmt={fmt.short}
          zeroBase
          to="/metrics/views"
        />
        <ReportMetricCard
          title="Подписчики"
          total={drillMeta.subscribers.total}
          trend={drillMeta.subscribers.trend}
          series={subsSpark}
          valueFmt={fmt.num}
          to="/metrics/subscribers"
        />
      </div>

      {/* Понедельный срез с heat-шейдингом (steep Reports table). */}
      {weekly && (
        <ChartSection title="По неделям · последние 6">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr>
                  <th className="py-1.5 pr-2 text-left text-2xs font-medium tracking-wide text-muted-foreground">
                    нед. с
                  </th>
                  {weekly.weeks.map((w) => (
                    <th key={w.key} className="px-1 py-1.5 text-right text-2xs font-medium tabular-nums text-muted-foreground">
                      {w.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {weekly.rows.map((row) => {
                  const rowMax = Math.max(...row.values.map((v) => (v == null ? 0 : Math.abs(v))), 0);
                  return (
                    <tr key={row.label} className="border-t border-border">
                      <td className="py-1 pr-2 text-xs text-muted-foreground">{row.label}</td>
                      {row.values.map((value, i) => (
                        <td key={weekly.weeks[i].key} className="px-1 py-1">
                          <div className="relative overflow-hidden rounded px-2 py-1 text-right tabular-nums">
                            <div aria-hidden="true" className="absolute inset-0" style={cellTint(value, rowMax, row.signed)} />
                            <span className="relative">
                              {value == null
                                ? '—'
                                : row.signed
                                  ? `${value > 0 ? '+' : value < 0 ? '−' : ''}${fmt.num(Math.abs(value))}`
                                  : fmt.short(value)}
                            </span>
                          </div>
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-2xs text-muted-foreground">
            Заливка — доля от максимума строки; источник — дневной архив, последняя неделя может быть неполной.
          </p>
        </ChartSection>
      )}

      {/* Наблюдения + лучшие публикации — the existing analyst blocks, document-ordered. */}
      <ChartSection title="Наблюдения">
        <Insights />
      </ChartSection>
      <ChartSection title="Лучшие публикации">
        <TopPosts />
      </ChartSection>

      <p className="border-t border-border pt-3 text-2xs text-muted-foreground">
        Сгенерировано Atlavue · {generated} · данные: Telegram (MTProto) + дневной архив сборщика.
      </p>
    </div>
  );
}

interface ReportMetricCardProps {
  title: string;
  total: string;
  trend?: import('@/lib/delta').MetricDelta | null;
  series: DailySeries;
  valueFmt: (n: number) => string;
  zeroBase?: boolean;
  to: string;
}

/** Compact metric card for the report grid: headline + chart + a link to the metric page. */
function ReportMetricCard({ title, total, trend, series, valueFmt, zeroBase, to }: ReportMetricCardProps) {
  return (
    <section className="min-w-0 space-y-3">
      <div className="flex items-center gap-3">
        <h3 className="whitespace-nowrap text-xs font-medium tracking-wider text-muted-foreground">{title}</h3>
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
        <Link to={to} className="whitespace-nowrap text-2xs font-medium text-primary transition-colors hover:text-primary/80 print:hidden">
          Открыть →
        </Link>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-medium tabular-nums tracking-tight">{total}</span>
        <DeltaPill delta={trend} subtle />
      </div>
      <LineChart
        values={series.values}
        labels={series.labels}
        titles={series.values.map((v, i) => `${series.labels[i]}: ${valueFmt(v)}`)}
        height={170}
        markExtremes
        showPoints={series.values.length > 1 && series.values.length <= 45}
        yMin={zeroBase && series.values.length > 1 ? 0 : undefined}
      />
    </section>
  );
}

function ReportSkeleton() {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-10">
      <div>
        <Skeleton className="h-3 w-52" />
        <Skeleton className="mt-2 h-8 w-72" />
        <Skeleton className="mt-4 h-10 w-full" />
      </div>
      <div className="grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="bg-background p-3">
            <Skeleton className="h-2.5 w-14" />
            <Skeleton className="mt-2 h-5 w-16" />
          </div>
        ))}
      </div>
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
