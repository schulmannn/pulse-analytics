import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useChannels, useDeleteReport, useHistory, useReport, useTgFull, useUpdateReport } from '@/api/queries';
import type { ReportSchedule } from '@/api/queries';
import { ApiError } from '@/api/client';
import type { Report, ReportConfig } from '@/api/schemas';
import { ChannelScope, useSelectedChannel } from '@/lib/channel-context';
import { useDemo } from '@/lib/demo-context';
import { usePeriod } from '@/lib/period';
import type { PeriodDays } from '@/lib/period';
import { deriveKpis, filledDailySeries, sparseDailySeries, isDrillKey } from '@/lib/kpiDerive';
import type { DailySeries, DrillKey, PostMetricField } from '@/lib/kpiDerive';
import { DAY_MS, buildWeeklyTable, cellTint } from '@/lib/reportTables';
import { defaultBlock, isReportBlockKey, normalizeBlocks } from '@/lib/reportBlocks';
import type { ReportBlock, ReportBlockKey, ReportBlockType } from '@/lib/reportBlocks';
import { fmt } from '@/lib/format';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { ReportDocumentDesktop } from '@/panels/report/ReportDocumentDesktop';
import { Skeleton } from '@/components/ui/skeleton';
import { DeltaPill } from '@/components/DeltaPill';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { PillSelect } from '@/components/PillSelect';
import { ChartSection } from '@/components/instagram/shared';
import { NarrativeWeekBody } from '@/panels/NarrativeWeek';
import { Insights } from '@/panels/Insights';
import { TopPosts } from '@/panels/TopPosts';
import { BlockControls, BlockFrame, MiniSelect, PencilGlyph, Segmented } from '@/panels/report/blockChrome';
import { CHART_METRICS, InlineAdd, LEDGER, MapBlock, NotEnough, PERIOD_CHIPS, ReportChart, ReportMetricCard, TABLE_SOURCES, TextBlock } from '@/panels/report/blocks';

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
  return <ErrorState title="Не удалось загрузить отчёт" reason={error instanceof Error ? error.message : 'ошибка'} />;
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
 * Отчёт — the steep-Reports document. Composed from config.blocks as generic { id, type, config }
 * blocks (text / chart / table / bignumber / map / divider) plus `preset` bridges for the curated
 * sections. Editing is always-on and inline (owner-only surface): a hover «+» in every gap adds a
 * block, each block has a hover toolbar (↑ / ↓ / ×) and its own inline config controls. All of
 * that chrome — plus the filter bar, schedule and rename — is print-hidden, so «Печать / PDF»
 * emits a clean document.
 */
function ReportDocument({ report }: { report: Report }) {
  // Persistent report source (config.channelId): the whole document — including the top-level
  // data fetches inside the body — runs under a ChannelScope pinned to it. Local state echoes
  // the config instantly on pick; persistence differs per surface (desktop: single Save PUT;
  // mobile: the historical debounced config PUT). null = follow the switcher.
  const [source, setSource] = useState<number | null>(
    typeof report.config.channelId === 'number' ? report.config.channelId : null,
  );
  // Desktop (md+) gets the read/edit document; mobile keeps its verbatim always-inline surface.
  // JS branch (not CSS): only one mounts, so the report-scoped hooks run once for the active one.
  const isDesktop = useMediaQuery('(min-width: 768px)');
  return (
    <ChannelScope channelId={source}>
      {isDesktop ? (
        <ReportDocumentDesktop report={report} onPickSource={setSource} />
      ) : (
        <ReportDocumentBody report={report} source={source} onPickSource={setSource} />
      )}
    </ChannelScope>
  );
}

function ReportDocumentBody({
  report,
  source,
  onPickSource,
}: {
  report: Report;
  source: number | null;
  onPickSource: (id: number | null) => void;
}) {
  const { days, setDays, range, setRange, inRange } = usePeriod();
  const { data, isPending, isError, error } = useTgFull(days, { windowPair: true });
  const { data: history } = useHistory(730);
  const { channelId } = useSelectedChannel();
  const { data: channelsData } = useChannels();
  const navigate = useNavigate();
  const updateReport = useUpdateReport(report.id);
  const deleteReport = useDeleteReport();

  const [channelOpen, setChannelOpen] = useState(false);
  const channelRef = useRef<HTMLDivElement>(null);
  const channelBtnRef = useRef<HTMLButtonElement>(null);
  // Close the source dropdown on outside click / Escape (same dismiss wiring as InlineAdd).
  // Escape refocuses the trigger — the focused row unmounts with the dropdown.
  useEffect(() => {
    if (!channelOpen) return;
    const onDown = (e: MouseEvent) => {
      if (channelRef.current && !channelRef.current.contains(e.target as Node)) setChannelOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setChannelOpen(false);
        channelBtnRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [channelOpen]);

  const [renaming, setRenaming] = useState(false);
  const cancelRename = useRef(false);
  // After a rename commits/cancels the input unmounts — return focus to the reappearing
  // pencil button (guarded so the initial mount, where renaming starts false, is unaffected).
  const pencilRef = useRef<HTMLButtonElement>(null);
  const wasRenaming = useRef(false);
  useEffect(() => {
    if (wasRenaming.current && !renaming) pencilRef.current?.focus();
    wasRenaming.current = renaming;
  }, [renaming]);

  // Schedule select — optimistic: local state mirrors report.schedule so the control never
  // snaps back mid-flight; the server echo reconciles it on success, an error reverts it
  // (the «Не сохранилось» hint below covers the failure).
  const [schedule, setSchedule] = useState<ReportSchedule>(report.schedule as ReportSchedule);
  const pickSchedule = (next: ReportSchedule) => {
    const prev = schedule;
    setSchedule(next);
    updateReport.mutate(
      { schedule: next },
      {
        onSuccess: (data) => setSchedule(data.report.schedule as ReportSchedule),
        onError: () => setSchedule(prev),
      },
    );
  };

  // Block layout — client-side truth while editing; the server config is the durable copy.
  // normalizeBlocks handles legacy string[] / new object[] / missing (default set) / [] (empty).
  const [blocks, setBlocks] = useState<ReportBlock[]>(() => normalizeBlocks(report.config.blocks));

  // ── Debounced config persistence (blocks + periodDays PUT as one JSONB patch) ──
  // Seed cfgRef with the SAME normalized blocks the state holds (one genId pass) so any first
  // PUT — even a period-only one — writes the migrated object[] shape, not the legacy strings.
  const cfgRef = useRef<ReportConfig>({ ...report.config, blocks });
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
    return <ErrorState title="Не удалось построить отчёт" reason={error instanceof Error ? error.message : 'ошибка'} />;
  }

  const channels = channelsData?.channels ?? [];
  const current = channels.find((c) => c.id === channelId);
  const channelName = String(current?.username || current?.title || current?.id || '');
  const { drillMeta, periodLabel, subsSpark } = derived;

  // Daily series for the metric-card blocks (same math as the /metrics pages).
  const winTo = range ? range.to : Date.now();
  const winFrom = range ? range.from : days > 0 ? winTo - (days - 1) * DAY_MS : null;
  const dailyFor = (field: PostMetricField): DailySeries =>
    winFrom != null && (winTo - winFrom) / DAY_MS <= 366
      ? filledDailySeries(derived.normPosts, field, winFrom, winTo)
      : sparseDailySeries(derived.normPosts, field);
  const viewsSeries = dailyFor('reach');
  const reactionsSeries = dailyFor('likes');

  const rangeLabel = range ? `${fmt.day(range.from)} – ${fmt.day(range.to)}` : null;
  // An instant renders as the viewer's local day now that fmt.day takes Date/epoch directly.
  const generated = fmt.day(new Date());

  const chipBase = 'rounded-full border px-3 py-1 text-xs font-medium transition-colors';
  const chipActive = 'border-primary/40 bg-primary/10 text-primary';
  const chipIdle = 'border-border text-muted-foreground hover:text-foreground';

  // ── Block edit handlers ──
  const applyBlocks = (next: ReportBlock[]) => {
    setBlocks(next);
    commitConfig({ blocks: next });
  };
  const insertBlock = (at: number, type: ReportBlockType, presetKey?: ReportBlockKey) => {
    const block = defaultBlock(type, presetKey);
    applyBlocks([...blocks.slice(0, at), block, ...blocks.slice(at)]);
  };
  const moveBlock = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    [next[idx], next[j]] = [next[j], next[idx]];
    applyBlocks(next);
  };
  const removeBlock = (idx: number) => applyBlocks(blocks.filter((_, i) => i !== idx));
  const setBlockConfig = (idx: number, patch: Record<string, unknown>) =>
    applyBlocks(blocks.map((b, i) => (i === idx ? { ...b, config: { ...b.config, ...patch } } : b)));

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

  // ── Curated (preset) renderers — the sections the single report used to hard-code ──
  const renderKpiLedger = (): ReactNode => (
    <div className="grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
      {LEDGER.map(({ key: k, label }) => (
        <Link key={k} to={`/metrics/${k}`} className="bg-background p-3 transition-colors hover:bg-muted/60">
          <div className="text-2xs tracking-wide text-muted-foreground">{label}</div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-2xl font-medium tabular-nums tracking-tight">{drillMeta[k].total}</span>
            <DeltaPill delta={drillMeta[k].trend} subtle />
          </div>
        </Link>
      ))}
    </div>
  );

  const renderWeeklyTable = (): ReactNode => {
    if (!weekly) return null;
    return (
      <div className="data-table-surface data-table-scroll">
        <table className="data-table data-table--compact min-w-[560px] text-sm">
          <thead>
            <tr>
              <th className="py-1.5 pr-2 text-left text-2xs font-medium tracking-wide text-muted-foreground">нед. с</th>
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
        <p className="mt-2 text-2xs text-muted-foreground">
          Заливка — доля от максимума строки; источник — дневной архив, последняя неделя может быть неполной.
        </p>
      </div>
    );
  };

  const renderPreset = (key: ReportBlockKey): ReactNode => {
    switch (key) {
      case 'kpi-summary':
        return <ChartSection title="Сводка">{renderKpiLedger()}</ChartSection>;
      case 'week':
      // 'digest' is the deprecated alias — the narrative replaces the old Digest «Инсайт» block.
      case 'digest':
        return (
          <ChartSection title="Неделя канала">
            <NarrativeWeekBody />
          </ChartSection>
        );
      case 'metric-views':
        return (
          <ReportMetricCard title="Просмотры по дням" total={drillMeta.views.total} trend={drillMeta.views.trend}
            series={viewsSeries} valueFmt={fmt.short} zeroBase to="/metrics/views" />
        );
      case 'metric-subscribers':
        return (
          <ReportMetricCard title="Подписчики по дням" total={drillMeta.subscribers.total} trend={drillMeta.subscribers.trend}
            series={subsSpark} valueFmt={fmt.num} to="/metrics/subscribers" />
        );
      case 'metric-reactions':
        return (
          <ReportMetricCard title="Реакции по дням" total={drillMeta.reactions.total} trend={drillMeta.reactions.trend}
            series={reactionsSeries} valueFmt={fmt.short} zeroBase to="/metrics/reactions" />
        );
      case 'weekly-table': {
        const table = renderWeeklyTable();
        return table && <ChartSection title="По неделям · последние 6">{table}</ChartSection>;
      }
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

  // Chart / big-number metric → its daily series + KPI headline (reconciles with the ledger).
  const chartSpec = (metric: string): { series: DailySeries; valueFmt: (n: number) => string; zeroBase: boolean; label: string; drill: DrillKey } => {
    switch (metric) {
      case 'subscribers':
        return { series: subsSpark, valueFmt: fmt.num, zeroBase: false, label: 'Подписчики по дням', drill: 'subscribers' };
      case 'reactions':
        return { series: dailyFor('likes'), valueFmt: fmt.short, zeroBase: true, label: 'Реакции по дням', drill: 'reactions' };
      case 'forwards':
        return { series: dailyFor('shares'), valueFmt: fmt.short, zeroBase: true, label: 'Репосты по дням', drill: 'forwards' };
      case 'views':
      default:
        return { series: dailyFor('reach'), valueFmt: fmt.short, zeroBase: true, label: 'Просмотры по дням', drill: 'views' };
    }
  };

  // ── Generic block renderer ──
  const renderContent = (block: ReportBlock, idx: number): ReactNode => {
    switch (block.type) {
      case 'preset': {
        const key = block.config.key;
        return typeof key === 'string' && isReportBlockKey(key) ? renderPreset(key) : null;
      }
      case 'divider':
        return <hr className="border-0 border-t border-border" />;
      case 'text':
        return (
          <TextBlock
            value={typeof block.config.text === 'string' ? block.config.text : ''}
            onChange={(text) => setBlockConfig(idx, { text })}
          />
        );
      case 'bignumber': {
        const metric: DrillKey = typeof block.config.metric === 'string' && isDrillKey(block.config.metric) ? block.config.metric : 'views';
        const label = LEDGER.find((l) => l.key === metric)?.label ?? metric;
        return (
          <div>
            <BlockControls>
              <MiniSelect ariaLabel="Метрика" value={metric} onChange={(v) => setBlockConfig(idx, { metric: v })}
                options={LEDGER.map((l) => ({ value: l.key, label: l.label }))} />
            </BlockControls>
            <div className="text-xs font-medium tracking-wider text-muted-foreground">{label}</div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl font-medium tabular-nums tracking-tight">{drillMeta[metric].total}</span>
              <DeltaPill delta={drillMeta[metric].trend} />
            </div>
          </div>
        );
      }
      case 'chart': {
        const rawMetric = typeof block.config.metric === 'string' ? block.config.metric : 'views';
        const metric = CHART_METRICS.some((m) => m.value === rawMetric) ? rawMetric : 'views';
        const viz: 'line' | 'bar' = block.config.viz === 'bar' ? 'bar' : 'line';
        const spec = chartSpec(metric);
        return (
          <section className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="whitespace-nowrap text-xs font-medium tracking-wider text-muted-foreground">{spec.label}</h3>
              <span aria-hidden="true" className="h-px flex-1 bg-border" />
              <BlockControls>
                <MiniSelect ariaLabel="Метрика" value={metric} onChange={(v) => setBlockConfig(idx, { metric: v })} options={CHART_METRICS} />
                <Segmented value={viz} onChange={(v) => setBlockConfig(idx, { viz: v })}
                  options={[{ value: 'line', label: 'Линия' }, { value: 'bar', label: 'Столбцы' }]} />
              </BlockControls>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-medium tabular-nums tracking-tight">{drillMeta[spec.drill].total}</span>
              <DeltaPill delta={drillMeta[spec.drill].trend} subtle />
            </div>
            <ReportChart series={spec.series} viz={viz} valueFmt={spec.valueFmt} zeroBase={spec.zeroBase} />
          </section>
        );
      }
      case 'table': {
        const rawSource = typeof block.config.source === 'string' ? block.config.source : 'weekly';
        const source = TABLE_SOURCES.some((s) => s.value === rawSource) ? rawSource : 'weekly';
        const body =
          source === 'top-posts' ? <TopPosts /> : source === 'kpi-ledger' ? renderKpiLedger() : renderWeeklyTable();
        const label = TABLE_SOURCES.find((s) => s.value === source)?.label ?? 'Таблица';
        return (
          <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="whitespace-nowrap text-xs font-medium tracking-wider text-muted-foreground">{label}</h3>
              <span aria-hidden="true" className="h-px flex-1 bg-border" />
              <BlockControls>
                <MiniSelect ariaLabel="Источник" value={source} onChange={(v) => setBlockConfig(idx, { source: v })} options={TABLE_SOURCES} />
              </BlockControls>
            </div>
            {body ?? <NotEnough />}
          </section>
        );
      }
      case 'map':
        return <MapBlock />;
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl">
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
            className="mt-1 w-full border-b border-primary/40 bg-transparent text-3xl font-medium tracking-tight text-foreground focus:border-primary focus:outline-hidden"
          />
        ) : (
          <h2 className="mt-1 flex items-baseline gap-2 text-3xl font-medium tracking-tight">
            <span className="min-w-0 wrap-break-word">{report.name}</span>
            <button
              ref={pencilRef}
              type="button"
              onClick={() => setRenaming(true)}
              title="Переименовать отчёт"
              aria-label="Переименовать отчёт"
              className="shrink-0 self-center rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground print:hidden"
            >
              <PencilGlyph className="h-4 w-4" />
            </button>
          </h2>
        )}
        <p className="mt-1 text-sm text-muted-foreground">
          @{channelName} — {rangeLabel ?? periodLabel}
        </p>

        {/* Global filter bar (steep Reports): period / channel / platform pills + print. */}
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
          {channels.length >= 2 || source != null ? (
            /* «Источник» отчёта — ПЕРСИСТЕНТНЫЙ (config.channelId), не глобальный свитчер:
               выбор закрепляет документ за каналом на всех устройствах; «Как в свитчере»
               возвращает старое поведение. Активный chip подсвечен, когда источник закреплён. */
            <div ref={channelRef} className="relative">
              <button
                ref={channelBtnRef}
                type="button"
                onClick={() => setChannelOpen((v) => !v)}
                aria-expanded={channelOpen}
                title={source != null ? 'Источник закреплён за отчётом' : 'Источник — как в свитчере'}
                className={`${chipBase} ${source != null ? chipActive : chipIdle}`}
              >
                @{channelName} ⌄
              </button>
              {channelOpen && (
                <div className="absolute left-0 top-full z-popover mt-1 w-52 rounded-xl border border-border bg-card p-1">
                  <button
                    type="button"
                    onClick={() => {
                      channelBtnRef.current?.focus();
                      onPickSource(null);
                      commitConfig({ channelId: undefined });
                      setChannelOpen(false);
                    }}
                    className={`block w-full rounded px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted ${
                      source == null ? 'text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    Как в свитчере
                  </button>
                  <div className="my-1 border-t border-border" aria-hidden="true" />
                  {channels.map((channel) => {
                    const name = String(channel.username || channel.title || channel.id);
                    return (
                      <button
                        key={channel.id}
                        type="button"
                        aria-current={channel.id === channelId ? 'true' : undefined}
                        onClick={() => {
                          channelBtnRef.current?.focus();
                          onPickSource(channel.id);
                          commitConfig({ channelId: channel.id });
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
            <span className={`${chipBase} cursor-default border-border text-muted-foreground`}>@{channelName}</span>
          )}
          <span className={`${chipBase} cursor-default border-border text-muted-foreground`}>Telegram</span>
          <span className="flex-1" />
          <button type="button" onClick={() => window.print()} className={`${chipBase} ${chipIdle}`}>
            Печать / PDF
          </button>
        </div>

        {/* Email schedule — the scheduler mails a LINK to this report (weekly Mon / monthly 1st, UTC). */}
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 print:hidden">
          <label htmlFor="report-schedule" className="text-xs text-muted-foreground">
            Выгрузка на почту
          </label>
          <PillSelect<ReportSchedule>
            id="report-schedule"
            value={schedule}
            onValueChange={pickSchedule}
            ariaLabel="Выгрузка на почту"
            options={[
              { value: 'none', label: 'Выкл' },
              { value: 'weekly', label: 'Раз в неделю' },
              { value: 'monthly', label: 'Раз в месяц' },
            ]}
          />
          <span className="text-2xs text-muted-foreground">письмо со ссылкой на отчёт</span>
          {updateReport.isError && (
            <span className="text-2xs text-ember">
              Не сохранилось: {updateReport.error instanceof Error ? updateReport.error.message : 'ошибка'}
            </span>
          )}
        </div>
      </div>

      {/* The composed document: config.blocks in order, single-column. A hover «+» in every gap
          adds a block; each block carries a hover toolbar + its own inline config controls. */}
      <div className="mt-8">
        <InlineAdd onAdd={(type, key) => insertBlock(0, type, key)} />
        {blocks.map((block, idx) => (
          <Fragment key={block.id}>
            <div className="print:mt-6">
              <BlockFrame idx={idx} count={blocks.length} onMove={moveBlock} onRemove={removeBlock}>
                {renderContent(block, idx) ?? <NotEnough />}
              </BlockFrame>
            </div>
            <InlineAdd onAdd={(type, key) => insertBlock(idx + 1, type, key)} />
          </Fragment>
        ))}
        {blocks.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Пустой отчёт. Нажмите «+», чтобы добавить блок.
          </p>
        )}
      </div>

      {/* Footer — the printed generation note stays; delete is screen-only owner chrome. */}
      <div className="mt-10 flex items-start justify-between gap-3 border-t border-border pt-3">
        <p className="text-2xs text-muted-foreground">
          Сгенерировано Atlavue · {generated} · данные: Telegram (MTProto) + дневной архив сборщика.
        </p>
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleteReport.isPending}
          className="shrink-0 text-xs font-medium text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50 print:hidden"
        >
          {deleteReport.isPending ? 'Удаление…' : 'Удалить отчёт'}
        </button>
      </div>
    </div>
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
