import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DeltaPill } from '@/components/DeltaPill';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { ChartExpandedContext } from '@/components/ExpandableChart';
import type { MetricDelta } from '@/lib/delta';
import type { DailySeries, DrillKey } from '@/lib/kpiDerive';
import type { PeriodDays } from '@/lib/period';
import { REPORT_BLOCKS } from '@/lib/reportBlocks';
import type { ReportBlockKey, ReportBlockType } from '@/lib/reportBlocks';

// Inline «+» type menu. Desktop Telegram reports suppress «Карта» because the source exposes no
// geography; the frozen mobile builder keeps its historical catalog until the mobile redesign.
const ADD_TYPES: Array<{ type: ReportBlockType; label: string; hint: string }> = [
  { type: 'text', label: 'Текст', hint: 'Заголовок или абзац' },
  { type: 'bignumber', label: 'Большое число', hint: 'Метрика с дельтой' },
  { type: 'chart', label: 'График', hint: 'Линия или столбцы' },
  { type: 'table', label: 'Таблица', hint: 'Недели · посты · сводка' },
  { type: 'map', label: 'Карта', hint: 'География аудитории' },
  { type: 'divider', label: 'Разделитель', hint: 'Горизонтальная линия' },
];

// Chart/big-number metric choices (those with an honest daily series or a KPI headline).
export const CHART_METRICS: Array<{ value: string; label: string }> = [
  { value: 'views', label: 'Просмотры' },
  { value: 'reactions', label: 'Реакции' },
  { value: 'forwards', label: 'Репосты' },
  { value: 'subscribers', label: 'Подписчики' },
];
export const TABLE_SOURCES: Array<{ value: string; label: string }> = [
  { value: 'weekly', label: 'По неделям' },
  { value: 'top-posts', label: 'Лучшие публикации' },
  { value: 'kpi-ledger', label: 'Сводка показателей' },
];

export const PERIOD_CHIPS: Array<{ days: PeriodDays; label: string }> = [
  { days: 7, label: '7д' },
  { days: 30, label: '30д' },
  { days: 90, label: '90д' },
  { days: 0, label: 'Всё' },
];

export const LEDGER: Array<{ key: DrillKey; label: string }> = [
  { key: 'views', label: 'Просмотры' },
  { key: 'subscribers', label: 'Подписчики' },
  { key: 'avgReach', label: 'Ср. охват' },
  { key: 'reactions', label: 'Реакции' },
  { key: 'forwards', label: 'Репосты' },
  { key: 'er', label: 'ER' },
];

// ── Inline «+» add-menu — the Notion/steep gap affordance ──────────────────────────────────
export function InlineAdd({
  onAdd,
  allowMap = true,
}: {
  onAdd: (type: ReportBlockType, presetKey?: ReportBlockKey) => void;
  allowMap?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="group/add relative flex h-10 items-center justify-center print:hidden">
      <span
        aria-hidden="true"
        className={`absolute inset-x-0 top-1/2 h-px -translate-y-1/2 transition-colors ${open ? 'bg-border' : 'bg-transparent group-hover/add:bg-border'}`}
      />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Добавить блок"
        aria-expanded={open}
        className={`relative z-10 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-background text-muted-foreground transition-opacity hover:text-foreground ${
          open ? 'opacity-100' : 'opacity-0 group-hover/add:opacity-100 focus-visible:opacity-100'
        }`}
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
          <path d="M8 3v10M3 8h10" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-1/2 top-full z-popover mt-1 w-64 -translate-x-1/2 rounded-xl border border-border bg-card p-1.5 text-left">
          {ADD_TYPES.filter((t) => allowMap || t.type !== 'map').map((t) => (
            <button
              key={t.type}
              type="button"
              onClick={() => {
                onAdd(t.type);
                setOpen(false);
              }}
              className="block w-full rounded px-2.5 py-1.5 text-left transition-colors hover:bg-muted"
            >
              <span className="block text-sm text-foreground">{t.label}</span>
              <span className="block text-2xs text-muted-foreground">{t.hint}</span>
            </button>
          ))}
          <div aria-hidden="true" className="mx-1 my-1 h-px bg-border" />
          <div className="px-2.5 py-1 text-2xs tracking-wide text-muted-foreground">Готовый блок</div>
          {REPORT_BLOCKS.map((b) => (
            <button
              key={b.key}
              type="button"
              onClick={() => {
                onAdd('preset', b.key);
                setOpen(false);
              }}
              className="block w-full rounded px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {b.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
/** Freeform text block: a borderless auto-growing textarea on screen (always editable),
    mirrored by a print-only paragraph so the printed document stays clean. */
export function TextBlock({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={1}
        placeholder="Текст…"
        aria-label="Текстовый блок"
        className="block w-full resize-none rounded border-0 bg-transparent p-0 text-base leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/60 focus:ring-1 focus:ring-primary print:hidden"
      />
      <p className="hidden whitespace-pre-wrap text-base leading-relaxed text-foreground print:block">{value}</p>
    </>
  );
}

/** Audience map — deferred stub: Telegram exposes no geo, so this is an honest placeholder
    (ready to wire Instagram country/city demographics when a report can target an IG source). */
export function MapBlock() {
  return (
    <section className="report-section space-y-3">
      <h3 className="report-section__heading flex items-center gap-3 text-xs font-medium tracking-wider text-muted-foreground">
        <span className="whitespace-nowrap">Карта аудитории</span>
        <span aria-hidden="true" className="report-section__rule h-px flex-1 bg-border" />
      </h3>
      <div className="rounded-xl border border-dashed border-border bg-background px-4 py-8 text-center">
        <p className="text-sm font-medium text-foreground">География недоступна для Telegram</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          Telegram не отдаёт географию аудитории. Блок появится для источников с демографией
          (Instagram: страны и города).
        </p>
      </div>
    </section>
  );
}

/** Not-enough-data placeholder for a block whose source is empty this period. */
export function NotEnough() {
  return <p className="py-6 text-center text-sm text-muted-foreground">Пока недостаточно данных для этого блока.</p>;
}

/** Generic chart-block renderer: LineChart, or BarChart in rich (ticks + value labels) mode. */
export function ReportChart({
  series,
  viz,
  valueFmt,
  zeroBase,
  chartAppearance = 'default',
  chartLabel,
}: {
  series: DailySeries;
  viz: 'line' | 'bar';
  valueFmt: (n: number) => string;
  zeroBase?: boolean;
  chartAppearance?: 'default' | 'rhea';
  chartLabel?: string;
}) {
  if (series.values.length <= 1) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Недостаточно точек за период</div>
    );
  }
  const titles = series.values.map((v, i) => `${series.labels[i]}: ${valueFmt(v)}`);
  if (viz === 'bar') {
    return (
      <ChartExpandedContext.Provider value={true}>
        <BarChart values={series.values} labels={series.labels} titles={titles} height={200} />
      </ChartExpandedContext.Provider>
    );
  }
  const rheaChart = chartAppearance === 'rhea';
  return (
    <LineChart
      values={series.values}
      labels={series.labels}
      titles={titles}
      height={200}
      fullAxes
      markExtremes={!rheaChart}
      showPoints={!rheaChart && series.values.length <= 45}
      yMin={zeroBase ? 0 : undefined}
      formatValue={valueFmt}
      primaryLabel={chartLabel}
      appearance={chartAppearance}
    />
  );
}

interface ReportMetricCardProps {
  title: string;
  total: string;
  trend?: MetricDelta | null;
  series: DailySeries;
  valueFmt: (n: number) => string;
  zeroBase?: boolean;
  to: string;
  onOpen?: () => void;
  chartAppearance?: 'default' | 'rhea';
  chartLabel?: string;
}

/** Compact metric card for a preset metric-* block: headline + chart + whole-card metric drill. */
export function ReportMetricCard({ title, total, trend, series, valueFmt, zeroBase, to, onOpen, chartAppearance = 'default', chartLabel }: ReportMetricCardProps) {
  const rheaChart = chartAppearance === 'rhea';
  const navigate = useNavigate();
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  const openDetails = () => {
    onOpen?.();
    navigate(to);
  };
  return (
    <section
      className="report-metric-card min-w-0 space-y-3"
      data-report-chart-appearance={chartAppearance}
      data-report-chart-label={chartLabel}
      role="link"
      tabIndex={0}
      aria-label={`Открыть детали: ${title}`}
      onPointerDown={(event) => (pressRef.current = { x: event.clientX, y: event.clientY })}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('button, a, input, select, textarea, [role="dialog"]')) return;
        const press = pressRef.current;
        pressRef.current = null;
        if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) return;
        openDetails();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        openDetails();
      }}
    >
      <div className="report-metric-card__header flex items-center gap-3">
        <h3 className="report-metric-card__title whitespace-nowrap text-xs font-medium tracking-wider text-muted-foreground">{title}</h3>
        <span aria-hidden="true" className="report-metric-card__rule h-px flex-1 bg-border" />
      </div>
      <div className="report-metric-card__value flex items-baseline gap-2">
        <span className="report-metric-card__number text-2xl font-medium tabular-nums tracking-tight">{total}</span>
        <DeltaPill delta={trend} subtle />
      </div>
      <div className="report-metric-card__chart">
        <LineChart
          values={series.values}
          labels={series.labels}
          titles={series.values.map((v, i) => `${series.labels[i]}: ${valueFmt(v)}`)}
          height={rheaChart ? 200 : 170}
          fullAxes
          markExtremes={!rheaChart}
          showPoints={!rheaChart && series.values.length > 1 && series.values.length <= 45}
          yMin={zeroBase && series.values.length > 1 ? 0 : undefined}
          formatValue={valueFmt}
          primaryLabel={chartLabel}
          appearance={chartAppearance}
        />
      </div>
    </section>
  );
}
