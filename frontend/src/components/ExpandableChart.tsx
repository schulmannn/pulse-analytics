import { createContext, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DetailShell } from '@/components/DetailShell';
import { SegmentedControl } from '@/components/SegmentedControl';
import { fmt } from '@/lib/format';
import { pctDelta } from '@/lib/delta';
import { DeltaPill } from '@/components/DeltaPill';
import { observeSize } from '@/lib/observeSize';

/** True while rendering inside the expanded (modal) chart view. Charts opt into richer
    annotations there (full y-axis, value labels) without prop plumbing through the panels. */
export const ChartExpandedContext = createContext(false);

/** Chart height (px) requested by the expanded overlay; null = the caller's own height.
    Overrides the chart's `height` prop, so callers keep their compact inline sizing while
    the same element renders explorer-sized in the modal. */
export const ExpandedChartHeightContext = createContext<number | null>(null);

/** Per-widget target level («Целевой уровень» in the edit dialog). ChartSection provides it
    around the widget body (and, via portal context flow, the expanded overlay); LineChart
    draws a dashed goal line at the value. null = no target — the default everywhere else. */
export const WidgetTargetContext = createContext<number | null>(null);

/** Min/Max/Average reference lines for the expanded explorer. The overlay computes them from the
    visible `statsFor` values when the «Линии» toggle is on and provides them here; LineChart /
    BarChart draw a dashed hairline at each. null = off (the default everywhere else). */
export type ChartRefLines = { min: number; max: number; avg: number };
export const ChartRefLinesContext = createContext<ChartRefLines | null>(null);

// steep-style explorer sizing: the overlay chart is markedly taller than any inline card.
const EXPANDED_CHART_HEIGHT = 400;

/** The RICH (Tier-2) explorer configuration a chart can supply for its expanded view:
    period pills, a line↔bar toggle and a Мин/Макс/Среднее/Сумма strip. Every field is
    optional — with none of them the overlay just renders the given children at full axes
    (Tier-1). Shared by ExpandableChart and ChartSection's native `expand` prop. */
/** Explorer bucketing of a daily series (mirrors the widget dialog's «Грануляция»). */
export type ExplorerGrain = 'day' | 'week' | 'month';

export interface ChartExpandConfig {
  /** Period-windowed line presentation — when provided, the overlay grows 1М/3М/6М/Всё pills.
      Grainable configs receive the explorer's «День/Неделя/Месяц» choice as the 2nd arg. */
  renderExpanded?: (days: number, grain?: ExplorerGrain) => ReactNode;
  /** Bar presentation of the same window — when provided, the overlay grows a line↔bar toggle. */
  renderExpandedBar?: (days: number, grain?: ExplorerGrain) => ReactNode;
  /** Values visible in the current window — feeds the Мин/Макс/Среднее/Сумма strip. */
  statsFor?: (days: number, grain?: ExplorerGrain) => number[];
  /** Include «Сумма» in the stats strip (default). Off for level/stock series
      (e.g. subscriber counts) where summing the values is meaningless. */
  statsSum?: boolean;
  /** The renderers honour the grain arg (flow series bucketed by week/month). Off for level
      series — bucketing sums would lie there, so the segment stays hidden. */
  grainable?: boolean;
}

interface ExpandableChartProps extends ChartExpandConfig {
  title: string;
  children: ReactNode;
}

// Канон периодов продукта (PR #86): «7д/30д/90д/Всё». Месячные «1М/3М/6М» переименовывали
// выбранное пользователем окно, а snapToWindow молча терял 7д (дизайн-аудит).
const WINDOWS = [
  { days: 7, label: '7д' },
  { days: 30, label: '30д' },
  { days: 90, label: '90д' },
  { days: 0, label: 'Всё' },
];

/**
 * Chart wrapper with an explicit expand affordance. The chart body itself is NOT
 * clickable — hovering/reading points must never hijack into the modal — expansion
 * happens only via the ↗ button in the corner.
 *
 * Kept as a thin wrapper over the shared {@link ChartExpandOverlay} so standalone callers
 * (the metric-page main chart etc.) stay untouched. Inside a widget shell, prefer the
 * ChartSection `expand` prop — it renders one consistent «Развернуть» per card.
 */
export function ExpandableChart({ title, children, renderExpanded, renderExpandedBar, statsFor, statsSum = true, grainable }: ExpandableChartProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <div className="relative">
        {children}
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          aria-label="Развернуть график"
          title="Развернуть график"
          className="absolute right-1 top-1 z-10 rounded-full border border-transparent p-1 text-muted-foreground transition-colors hover:border-border hover:bg-background hover:text-foreground"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M7 17 17 7M9 7h8v8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {isOpen && (
        <ChartExpandOverlay
          title={title}
          renderExpanded={renderExpanded}
          renderExpandedBar={renderExpandedBar}
          statsFor={statsFor}
          statsSum={statsSum}
          grainable={grainable}
          onClose={() => setIsOpen(false)}
        >
          {children}
        </ChartExpandOverlay>
      )}
    </>
  );
}

interface ChartExpandOverlayProps extends ChartExpandConfig {
  title: string;
  children: ReactNode;
  /** Window the overlay opens on (px pills 1М/3М/6М/Всё). Snapped to the nearest available
      pill; anything without a matching pill falls back to 3М (90д). Used to open a rich-expand
      chart on the host widget's own period. */
  initialDays?: number;
  onClose: () => void;
  /** Clicked-card rect for the shared-element grow (forwarded to DetailShell). */
  originRect?: DOMRect | null;
  /** The host widget's accent-token overrides (--brand-iris + chart roles). The overlay lives in
      a portal, OUTSIDE the widget subtree that scopes them — re-declared here (on a
      display:contents wrapper) so the expanded chart keeps the card's accent. */
  accentStyle?: CSSProperties;
}

/** Snap an arbitrary day count to the nearest overlay window pill (default 3М). */
function snapToWindow(days: number | undefined): number {
  if (days === 0) return 0;
  if (days != null && WINDOWS.some((w) => w.days === days)) return days;
  return 90;
}

/**
 * Expanded chart overlay — the reusable explorer dialog. Same dialog contract as
 * PostDetailModal: portal, role="dialog" + aria-modal, focus trap, body scroll lock,
 * Escape/backdrop/× to close. The backdrop is semi-transparent paper from the first frame
 * (an opaque black flash is what bg-black/50 produced while the blur composited).
 *
 * `renderExpanded` opts into period pills; `renderExpandedBar` adds a line↔bar toggle;
 * `statsFor` adds the stats strip. With none of them the overlay just renders `children`
 * at full explorer axes (Tier-1). Owns its own period + line/bar state, so a fresh open
 * always starts on the line at 3М — like the metric pages.
 */
export function ChartExpandOverlay({ title, children, renderExpanded, renderExpandedBar, statsFor, statsSum = true, grainable, initialDays, onClose, originRect, accentStyle }: ChartExpandOverlayProps) {
  const chartRegionRef = useRef<HTMLDivElement>(null);
  const [days, setDays] = useState(() => snapToWindow(initialDays));
  // Overlay-local presentation; reopening always starts on the line, like metric pages.
  const [kind, setKind] = useState<'line' | 'bar'>('line');
  const [grain, setGrain] = useState<ExplorerGrain>('day');
  // Full-screen explorer: the chart fills the viewport-height panel. Measure the flex-1
  // chart region and feed its height (minus a small breathing band) to the charts inside;
  // the fixed EXPANDED_CHART_HEIGHT stays as the pre-measure fallback.
  const [regionH, setRegionH] = useState<number | null>(null);
  useLayoutEffect(() => {
    const node = chartRegionRef.current;
    if (!node) return;
    const measure = () => setRegionH(node.clientHeight || null);
    measure();
    return observeSize(node, measure);
  }, []);
  const chartH = regionH ? Math.max(240, regionH - 8) : EXPANDED_CHART_HEIGHT;

  // «Линии» toggle: overlay Min/Max/Average reference lines over the series, computed from the same
  // visible values that feed the stats strip. Off by default; only offered with a stats source.
  const [showRefLines, setShowRefLines] = useState(false);
  const statsValues = statsFor ? statsFor(days, grain) : null;
  // Steep headline for the overlay — the SAME grammar as the card it opened from (number + Δ +
  // caption). Flow series (statsSum): the window total vs the previous same-length window,
  // sliced honestly out of statsFor(days*2). Level series: the current value vs the window start.
  const headline = (() => {
    if (!statsValues || statsValues.length === 0) return null;
    if (statsSum) {
      const total = statsValues.reduce((a, b) => a + b, 0);
      let delta: ReturnType<typeof pctDelta> | null = null;
      if (days !== 0 && statsFor) {
        const wide = statsFor(days * 2, grain);
        const prev = wide.slice(0, wide.length - statsValues.length);
        if (prev.length >= statsValues.length) {
          const prevTotal = prev.reduce((a, b) => a + b, 0);
          if (prevTotal > 0) delta = pctDelta(total, prevTotal);
        }
      }
      return { value: fmt.kpi(total), delta, caption: delta ? 'к пред. периоду' : days === 0 ? 'за всё время' : null };
    }
    const last = statsValues[statsValues.length - 1] ?? 0;
    const first = statsValues[0] ?? 0;
    const delta = first > 0 ? pctDelta(last, first) : null;
    return { value: fmt.kpi(last), delta, caption: delta ? 'к началу окна' : null };
  })();
  const refLines =
    showRefLines && statsValues && statsValues.length > 0
      ? {
          min: Math.min(...statsValues),
          max: Math.max(...statsValues),
          avg: statsValues.reduce((a, b) => a + b, 0) / statsValues.length,
        }
      : null;

  return (
    <DetailShell variant="panel" ariaLabel={`График: ${title}`} onClose={onClose} originRect={originRect}>
      {/* display:contents — no box of its own (the shell's flex layout is untouched), but the
          custom properties still compute here, carrying the widget accent into the portal. */}
      <div className="contents" style={accentStyle}>
        <CardHeader className="shrink-0 pr-12">
          <CardTitle className="text-base text-foreground">{title}</CardTitle>
          {headline && (
            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 pt-1.5">
              <span className="kpi-accent text-hero font-medium leading-none tabular-nums tracking-tight">{headline.value}</span>
              <DeltaPill delta={headline.delta} />
              {headline.caption && <span className="text-2xs text-muted-foreground">{headline.caption}</span>}
            </div>
          )}
          {(renderExpanded || renderExpandedBar) && (
            <div className="flex flex-wrap items-center gap-2 pt-2">
              {renderExpanded && (
                <SegmentedControl
                  ariaLabel="Окно"
                  value={String(days)}
                  onChange={(d) => setDays(Number(d))}
                  options={WINDOWS.map((window) => ({ value: String(window.days), content: window.label }))}
                />
              )}
              {grainable && (
                <SegmentedControl
                  ariaLabel="Грануляция"
                  className="shrink-0"
                  value={grain}
                  onChange={setGrain}
                  options={(['day', 'week', 'month'] as const).map((g) => ({
                    value: g,
                    content: g === 'day' ? 'День' : g === 'week' ? 'Неделя' : 'Месяц',
                  }))}
                />
              )}
              {statsFor && (
                <button
                  type="button"
                  aria-pressed={showRefLines}
                  onClick={() => setShowRefLines((v) => !v)}
                  className={`shrink-0 rounded border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    showRefLines ? 'border-primary/40 text-primary' : 'border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Линии
                </button>
              )}
              {renderExpandedBar && (
                <SegmentedControl
                  ariaLabel="Тип графика"
                  className="ml-auto shrink-0"
                  segmentClassName="w-8"
                  value={kind}
                  onChange={setKind}
                  options={[
                    { value: 'line', content: <OverlayKindIcon kind="line" />, ariaLabel: 'Тип графика: Линия', title: 'Линия' },
                    { value: 'bar', content: <OverlayKindIcon kind="bar" />, ariaLabel: 'Тип графика: Столбцы', title: 'Столбцы' },
                  ]}
                />
              )}
            </div>
          )}
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col">
          {/* No forced svg min-height here: stretching a fixed-viewBox svg with CSS
              distorts the axis/value text vertically in the expanded view. The flex-1 region
              is measured and its height fed to the charts — they fill the screen. */}
          <div ref={chartRegionRef} className="min-h-0 w-full flex-1 overflow-y-auto">
            <ChartExpandedContext.Provider value={true}>
              <ExpandedChartHeightContext.Provider value={chartH}>
                <ChartRefLinesContext.Provider value={refLines}>
                  {kind === 'bar' && renderExpandedBar
                    ? renderExpandedBar(days, grain)
                    : renderExpanded
                      ? renderExpanded(days, grain)
                      : children}
                </ChartRefLinesContext.Provider>
              </ExpandedChartHeightContext.Provider>
            </ChartExpandedContext.Provider>
          </div>
          <div className="shrink-0">
            <OverlayStats values={statsValues} statsSum={statsSum} />
          </div>
        </CardContent>
      </div>
    </DetailShell>
  );
}

/** The overlay's line↔bar glyph — icon-only content for the shared segmented toggle (its label
    rides the segment's `aria-label`). Same visual language as the metric-page segment. */
function OverlayKindIcon({ kind }: { kind: 'line' | 'bar' }) {
  return kind === 'line' ? (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M1.5 11.5 5.5 7l3 2.5 5.5-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
      <rect x="2" y="8" width="3" height="6" rx="0.5" />
      <rect x="6.5" y="4" width="3" height="10" rx="0.5" />
      <rect x="11" y="6" width="3" height="8" rx="0.5" />
    </svg>
  );
}

/** Мин · Макс · Среднее (· Сумма) of the visible values — a hairline ledger row under the chart.
    `statsSum={false}` drops the sum for level/stock series where it reads as nonsense. */
function OverlayStats({ values, statsSum = true }: { values: number[] | null; statsSum?: boolean }) {
  if (!values || values.length === 0) return null;
  const sum = values.reduce((s, v) => s + v, 0);
  const rows = [
    { label: 'Мин', value: fmt.kpi(Math.min(...values)) },
    { label: 'Макс', value: fmt.kpi(Math.max(...values)) },
    { label: 'Среднее', value: fmt.kpi(sum / values.length) },
    ...(statsSum ? [{ label: 'Сумма', value: fmt.kpi(sum) }] : []),
  ];
  return (
    <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-border pt-3 sm:grid-cols-4">
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between gap-3">
          <span className="text-2xs tracking-wide text-muted-foreground">{row.label}</span>
          <span className="text-sm font-medium tabular-nums text-foreground">{row.value}</span>
        </div>
      ))}
    </div>
  );
}
