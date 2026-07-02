import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useChannels, useDeleteReport, useHistory, useReport, useTgFull, useUpdateReport } from '@/api/queries';
import type { ReportSchedule } from '@/api/queries';
import { ApiError } from '@/api/client';
import type { HistoryData, Report, ReportConfig } from '@/api/schemas';
import { useSelectedChannel } from '@/lib/channel-context';
import { useDemo } from '@/lib/demo-context';
import { usePeriod } from '@/lib/period';
import type { PeriodDays } from '@/lib/period';
import { deriveKpis, filledDailySeries, sparseDailySeries } from '@/lib/kpiDerive';
import type { DailySeries, DrillKey, PostMetricField } from '@/lib/kpiDerive';
import { fmt } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DeltaPill } from '@/components/DeltaPill';
import { EmptyState } from '@/components/EmptyState';
import { LineChart } from '@/components/LineChart';
import { Icon } from '@/components/nav-icons';
import { ChartSection } from '@/components/instagram/shared';
import { Digest } from '@/panels/Digest';
import { Insights } from '@/panels/Insights';
import { TopPosts } from '@/panels/TopPosts';

const DAY_MS = 24 * 60 * 60 * 1000;

type HistoryRow = HistoryData['rows'][number];

// ── Block registry — every section the composed document can render, in the default order ──
// (the same order the single report used to hard-code). config.blocks stores these keys.
export type ReportBlockKey =
  | 'kpi-summary'
  | 'digest'
  | 'metric-views'
  | 'metric-subscribers'
  | 'metric-reactions'
  | 'weekly-table'
  | 'insights'
  | 'top-posts';

export const REPORT_BLOCKS: Array<{ key: ReportBlockKey; label: string }> = [
  { key: 'kpi-summary', label: 'Сводка' },
  { key: 'digest', label: 'Инсайт' },
  { key: 'metric-views', label: 'Просмотры по дням' },
  { key: 'metric-subscribers', label: 'Подписчики по дням' },
  { key: 'metric-reactions', label: 'Реакции по дням' },
  { key: 'weekly-table', label: 'По неделям' },
  { key: 'insights', label: 'Наблюдения' },
  { key: 'top-posts', label: 'Лучшие публикации' },
];
// Default document = the old single report's composition: «Подписчики» right after «Просмотры».
// «Реакции» stays in the registry (addable via «Настроить») but is not part of the default set.
export const DEFAULT_REPORT_BLOCKS: ReportBlockKey[] = REPORT_BLOCKS
  .map((b) => b.key)
  .filter((key) => key !== 'metric-reactions');

function isReportBlockKey(raw: string): raw is ReportBlockKey {
  return REPORT_BLOCKS.some((b) => b.key === raw);
}
const blockLabel = (key: ReportBlockKey): string => REPORT_BLOCKS.find((b) => b.key === key)?.label ?? key;

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
 * Shared reports empty/error surface (list + document): demo / 401 → a quiet "log in" hint,
 * 503 → the no-database explanation, 404 → not found + a way back, else the raw message.
 */
export function ReportsErrorState({ error, demo }: { error?: unknown; demo?: boolean }) {
  if (demo || (error instanceof ApiError && error.status === 401)) {
    return <EmptyState title="Отчёты доступны после входа" reason="Сохранённые отчёты привязаны к аккаунту." />;
  }
  if (error instanceof ApiError && error.status === 503) {
    return <EmptyState title="Отчёты требуют базу данных" reason={error.message} />;
  }
  if (error instanceof ApiError && error.status === 404) {
    return <EmptyState title="Отчёт не найден" action={{ to: '/reports', label: 'К списку отчётов' }} />;
  }
  return (
    <EmptyState
      title="Не удалось загрузить отчёт"
      reason={error instanceof Error ? error.message : 'ошибка'}
    />
  );
}

/**
 * /reports/:id — a saved report document. Loads the report row (name / config / schedule),
 * then hands the composed rendering to ReportDocument, keyed by id so switching reports
 * resets the local editing state.
 */
export function ReportPage() {
  const params = useParams();
  const raw = params.id ?? '';
  const id = /^\d+$/.test(raw) ? Number(raw) : null;
  const { demo } = useDemo();
  const query = useReport(demo ? null : id);

  if (id == null) return <Navigate to="/reports" replace />;
  if (demo) {
    return (
      <div className="mx-auto w-full max-w-4xl">
        <ReportsErrorState demo />
      </div>
    );
  }
  if (query.isPending) return <ReportSkeleton />;
  if (query.isError) {
    return (
      <div className="mx-auto w-full max-w-4xl">
        <ReportsErrorState error={query.error} />
      </div>
    );
  }
  return <ReportDocument key={query.data.report.id} report={query.data.report} />;
}

/**
 * Отчёт — the steep-Reports adaptation (S4, the F3 base): the period as a readable document,
 * now composed from config.blocks (see REPORT_BLOCKS). A document header + global filter bar
 * (period / channel / platform — the same shared state the topbar drives, surfaced
 * document-style), then the configured blocks in order. Editing chrome (rename, «Настроить»
 * reorder/remove/add, the email-schedule select) is all print-hidden; «Печать / PDF» prints
 * just the document — the poor-man's export until F3 brings real PDF/share.
 */
function ReportDocument({ report }: { report: Report }) {
  const { days, setDays, range, setRange, inRange } = usePeriod();
  const { data, isPending, isError, error } = useTgFull(days, { windowPair: true });
  const { data: history } = useHistory(730);
  const { channelId, setChannelId } = useSelectedChannel();
  const { data: channelsData } = useChannels();
  const navigate = useNavigate();
  const updateReport = useUpdateReport(report.id);
  const deleteReport = useDeleteReport();

  const [channelOpen, setChannelOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const cancelRename = useRef(false);

  // Schedule select — optimistic: local state mirrors report.schedule so the control never
  // snaps back mid-flight; the server echo reconciles it on success, an error reverts it
  // (the «Не сохранилось» hint below covers the failure).
  const [schedule, setSchedule] = useState(report.schedule);
  const pickSchedule = (next: ReportSchedule) => {
    const prev = schedule;
    setSchedule(next);
    updateReport.mutate(
      { schedule: next },
      {
        onSuccess: (data) => setSchedule(data.report.schedule),
        onError: () => setSchedule(prev),
      },
    );
  };

  // Block layout — client-side truth while editing; the server config is the durable copy.
  // Unknown keys (older/newer client) are dropped; a MISSING list = the full default set,
  // while an explicitly emptied report ([]) stays empty.
  const [blocks, setBlocks] = useState<ReportBlockKey[]>(() => {
    const listed = report.config.blocks;
    if (listed == null) return [...DEFAULT_REPORT_BLOCKS];
    return [...new Set(listed.filter(isReportBlockKey))];
  });

  // ── Debounced config persistence (blocks + periodDays PUT as one JSONB patch) ──
  const cfgRef = useRef<ReportConfig>({ ...report.config });
  const timerRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);

  const flushConfig = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    updateReport.mutate({ config: cfgRef.current });
  }, [updateReport.mutate]); // eslint-disable-line react-hooks/exhaustive-deps -- mutate is stable

  const commitConfig = useCallback(
    (patch: Partial<ReportConfig>) => {
      cfgRef.current = { ...cfgRef.current, ...patch };
      dirtyRef.current = true;
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(flushConfig, 800);
    },
    [flushConfig],
  );

  // Unsent edits must not die with the page — flush the pending PUT on unmount.
  useEffect(() => () => flushConfig(), [flushConfig]);

  // Restore the persisted period preset once when the report opens (chip clicks re-save it) —
  // but only when the viewer hasn't already chosen a window: an active custom range or a shared
  // link's ?p= / ?from&to always wins over the saved preset (never touch `range`). After leaving
  // the report the period intentionally persists, same as changing it manually.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (range !== null) return;
    const search = typeof window !== 'undefined' ? window.location.search : '';
    if (search.includes('p=') || search.includes('from=')) return;
    const pd = report.config.periodDays;
    if (pd === 0 || pd === 7 || pd === 30 || pd === 90) setDays(pd);
  }, [range, report.config.periodDays, setDays]);

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
  const { drillMeta, normPosts, periodLabel, subsSpark } = derived;

  // Daily series for the metric-card blocks (same math as the /metrics pages).
  const winTo = range ? range.to : Date.now();
  const winFrom = range ? range.from : days > 0 ? winTo - (days - 1) * DAY_MS : null;
  const dailyFor = (field: PostMetricField): DailySeries =>
    winFrom != null && (winTo - winFrom) / DAY_MS <= 366
      ? filledDailySeries(normPosts, field, winFrom, winTo)
      : sparseDailySeries(normPosts, field);
  const viewsSeries = dailyFor('reach');
  const reactionsSeries = dailyFor('likes');

  const rangeLabel = range ? `${fmt.day(range.from)} – ${fmt.day(range.to)}` : null;
  // An instant renders as the viewer's local day now that fmt.day takes Date/epoch directly.
  const generated = fmt.day(new Date());

  const chipBase = 'rounded-full border px-3 py-1 text-xs font-medium transition-colors';
  const chipActive = 'border-primary/40 bg-primary/10 text-primary';
  const chipIdle = 'border-border text-muted-foreground hover:text-foreground';

  // ── Edit handlers ──
  const applyBlocks = (next: ReportBlockKey[]) => {
    setBlocks(next);
    commitConfig({ blocks: next });
  };
  const moveBlock = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    [next[idx], next[j]] = [next[j], next[idx]];
    applyBlocks(next);
  };
  const removeBlock = (idx: number) => applyBlocks(blocks.filter((_, i) => i !== idx));
  const pickPeriod = (d: PeriodDays) => {
    setDays(d);
    commitConfig({ periodDays: d });
  };
  const saveName = (raw: string) => {
    setRenaming(false);
    const next = raw.trim();
    if (next && next !== report.name && next.length <= 120) updateReport.mutate({ name: next });
  };
  const handleDelete = () => {
    if (!window.confirm(`Удалить отчёт «${report.name}»?`)) return;
    deleteReport.mutate(report.id, { onSuccess: () => navigate('/reports', { replace: true }) });
  };
  const missing = REPORT_BLOCKS.filter((b) => !blocks.includes(b.key));

  // ── Block renderers (key → the section the single report used to hard-code) ──
  const renderBlock = (key: ReportBlockKey): ReactNode => {
    switch (key) {
      case 'kpi-summary':
        // Сводка — the six KPIs as a hairline ledger (same numbers as the Overview).
        return (
          <ChartSection title="Сводка">
            <div className="grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
              {LEDGER.map(({ key: k, label }) => (
                <Link key={k} to={`/metrics/${k}`} className="bg-background p-3 transition-colors hover:bg-muted/60">
                  <div className="text-2xs tracking-wide text-muted-foreground">{label}</div>
                  <div className="mt-1 flex items-baseline gap-1.5">
                    <span className="text-xl font-medium tabular-nums tracking-tight">{drillMeta[k].total}</span>
                    <DeltaPill delta={drillMeta[k].trend} subtle />
                  </div>
                </Link>
              ))}
            </div>
          </ChartSection>
        );
      case 'digest':
        // Инсайт — Итог / Доказательство / Что сделать (label lives on the section).
        return (
          <ChartSection title="Инсайт">
            <Digest />
          </ChartSection>
        );
      case 'metric-views':
        return (
          <ReportMetricCard
            title="Просмотры по дням"
            total={drillMeta.views.total}
            trend={drillMeta.views.trend}
            series={viewsSeries}
            valueFmt={fmt.short}
            zeroBase
            to="/metrics/views"
          />
        );
      case 'metric-subscribers':
        // Подписчики — уровень по дням из дневного архива (stock-метрика: fitted scale, без zeroBase).
        return (
          <ReportMetricCard
            title="Подписчики по дням"
            total={drillMeta.subscribers.total}
            trend={drillMeta.subscribers.trend}
            series={subsSpark}
            valueFmt={fmt.num}
            to="/metrics/subscribers"
          />
        );
      case 'metric-reactions':
        return (
          <ReportMetricCard
            title="Реакции по дням"
            total={drillMeta.reactions.total}
            trend={drillMeta.reactions.trend}
            series={reactionsSeries}
            valueFmt={fmt.short}
            zeroBase
            to="/metrics/reactions"
          />
        );
      case 'weekly-table':
        // Понедельный срез с heat-шейдингом (steep Reports table). Needs ≥2 archive weeks.
        if (!weekly) return null;
        return (
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
        );
      case 'insights':
        return (
          <ChartSection title="Наблюдения">
            <Insights />
          </ChartSection>
        );
      case 'top-posts':
        return (
          <ChartSection title="Лучшие публикации">
            <TopPosts />
          </ChartSection>
        );
    }
  };

  // Consecutive metric-card blocks share a 2-up grid (the document's original layout);
  // everything else flows full-width.
  const groups: ReportBlockKey[][] = [];
  for (const key of blocks) {
    const last = groups[groups.length - 1];
    if (key.startsWith('metric-') && last && last[0].startsWith('metric-')) last.push(key);
    else groups.push([key]);
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-10">
      {/* Document header — the report reads as an artifact, not a dashboard view. */}
      <div>
        <div className="text-xs text-muted-foreground">Отчёт · Telegram · сгенерирован {generated}</div>
        {renaming ? (
          <input
            autoFocus
            defaultValue={report.name}
            maxLength={120}
            aria-label="Название отчёта"
            onBlur={(e) => {
              if (cancelRename.current) {
                cancelRename.current = false;
                setRenaming(false);
                return;
              }
              saveName(e.currentTarget.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                cancelRename.current = true;
                e.currentTarget.blur();
              }
            }}
            className="mt-1 w-full border-b border-primary/40 bg-transparent text-3xl font-medium tracking-tight text-foreground focus:outline-none"
          />
        ) : (
          <h2 className="mt-1 flex items-baseline gap-2 text-3xl font-medium tracking-tight">
            <span className="min-w-0 break-words">{report.name}</span>
            <button
              type="button"
              onClick={() => setRenaming(true)}
              title="Переименовать отчёт"
              aria-label="Переименовать отчёт"
              className="shrink-0 self-center rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground print:hidden"
            >
              <PencilGlyph className="h-4 w-4" />
            </button>
          </h2>
        )}
        <p className="mt-1 text-sm text-muted-foreground">
          @{channelName} — {rangeLabel ?? periodLabel}
        </p>

        {/* Global filter bar (steep Reports): period / channel / platform pills + configure + print. */}
        <div className="mt-4 flex flex-wrap items-center gap-2 border-y border-border py-3 print:hidden">
          {PERIOD_CHIPS.map((chip) => (
            <button
              key={chip.days}
              type="button"
              onClick={() => pickPeriod(chip.days)}
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
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            aria-pressed={editing}
            className={`${chipBase} ${editing ? chipActive : chipIdle}`}
          >
            Настроить
          </button>
          <button type="button" onClick={() => window.print()} className={`${chipBase} ${chipIdle}`}>
            Печать / PDF
          </button>
        </div>

        {/* Email schedule — the scheduler mails a LINK to this report (weekly Mon / monthly 1st, UTC). */}
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 print:hidden">
          <label htmlFor="report-schedule" className="text-xs text-muted-foreground">
            Выгрузка на почту
          </label>
          <select
            id="report-schedule"
            value={schedule}
            onChange={(e) => pickSchedule(e.target.value as ReportSchedule)}
            className="rounded border border-border bg-background px-2 py-1 text-xs font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="none">Выкл</option>
            <option value="weekly">Раз в неделю</option>
            <option value="monthly">Раз в месяц</option>
          </select>
          <span className="text-2xs text-muted-foreground">письмо со ссылкой на отчёт</span>
          {updateReport.isError && (
            <span className="text-2xs text-ember">
              Не сохранилось: {updateReport.error instanceof Error ? updateReport.error.message : 'ошибка'}
            </span>
          )}
        </div>
      </div>

      {/* The composed document: config.blocks in order; consecutive metric cards share a 2-up grid. */}
      {blocks.length === 0 && (
        <EmptyState title="В отчёте нет блоков" reason="Включите «Настроить» и добавьте блоки аналитики." />
      )}
      {groups.map((group) => {
        const items = group.map((key) => {
          const content = renderBlock(key);
          if (content == null && !editing) return null;
          const idx = blocks.indexOf(key);
          return (
            <BlockFrame
              key={key}
              label={blockLabel(key)}
              editing={editing}
              idx={idx}
              count={blocks.length}
              onMove={moveBlock}
              onRemove={removeBlock}
            >
              {content ?? (
                <p className="py-6 text-center text-sm text-muted-foreground">Пока недостаточно данных для этого блока.</p>
              )}
            </BlockFrame>
          );
        });
        return group[0].startsWith('metric-') ? (
          <div key={`g-${group[0]}`} className="grid grid-cols-1 gap-10 md:grid-cols-2">
            {items}
          </div>
        ) : (
          <Fragment key={`g-${group[0]}`}>{items}</Fragment>
        );
      })}

      {/* Configure-mode actions: add a missing block / delete the report. Screen-only chrome. */}
      {editing && (
        <div className="flex flex-wrap items-center gap-3 print:hidden">
          <div className="relative">
            <button
              type="button"
              onClick={() => setAddOpen((v) => !v)}
              disabled={missing.length === 0}
              aria-expanded={addOpen}
              className={`${chipBase} ${chipIdle} disabled:opacity-40`}
            >
              + Добавить блок
            </button>
            {addOpen && missing.length > 0 && (
              <div className="absolute bottom-full left-0 z-20 mb-1 w-56 rounded border border-border bg-card p-1">
                {missing.map((b) => (
                  <button
                    key={b.key}
                    type="button"
                    onClick={() => {
                      applyBlocks([...blocks, b.key]);
                      setAddOpen(false);
                    }}
                    className="block w-full rounded px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="flex-1" />
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleteReport.isPending}
            className="text-xs font-medium text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
          >
            {deleteReport.isPending ? 'Удаление…' : 'Удалить отчёт'}
          </button>
        </div>
      )}

      <p className="border-t border-border pt-3 text-2xs text-muted-foreground">
        Сгенерировано Atlavue · {generated} · данные: Telegram (MTProto) + дневной архив сборщика.
      </p>
    </div>
  );
}

/** Lucide-style pencil (inline — the nav icon set stays lean). */
function PencilGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  );
}

interface BlockFrameProps {
  label: string;
  editing: boolean;
  idx: number;
  count: number;
  onMove: (idx: number, dir: -1 | 1) => void;
  onRemove: (idx: number) => void;
  children: ReactNode;
}

/**
 * Configure-mode wrapper: a dashed hairline frame with ↑ / ↓ / × controls above the block.
 * Outside «Настроить» it renders the block bare — the printed document never sees the frame
 * (and even mid-edit the chrome is print-hidden, the border print-stripped).
 */
function BlockFrame({ label, editing, idx, count, onMove, onRemove, children }: BlockFrameProps) {
  if (!editing) return <>{children}</>;
  return (
    <div className="rounded border border-dashed border-border p-3 print:border-0 print:p-0">
      <div className="mb-2 flex items-center justify-between gap-2 print:hidden">
        <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        <div className="flex items-center gap-0.5">
          <BlockCtl onClick={() => onMove(idx, -1)} disabled={idx <= 0} label="Переместить выше">
            <Icon name="chevron" className="h-3.5 w-3.5 rotate-180" />
          </BlockCtl>
          <BlockCtl onClick={() => onMove(idx, 1)} disabled={idx >= count - 1} label="Переместить ниже">
            <Icon name="chevron" className="h-3.5 w-3.5" />
          </BlockCtl>
          <BlockCtl onClick={() => onRemove(idx)} label="Убрать блок">
            <span aria-hidden="true" className="text-sm leading-none">
              ×
            </span>
          </BlockCtl>
        </div>
      </div>
      {children}
    </div>
  );
}

/** Quiet 24px ghost control for the block frame (hover fill only, no border). */
function BlockCtl({
  onClick,
  disabled,
  label,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30"
    >
      {children}
    </button>
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
        fullAxes
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
