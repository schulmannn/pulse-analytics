import { createContext, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DetailShell } from '@/components/DetailShell';
import { fmt } from '@/lib/format';

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

const WINDOWS = [
  { days: 30, label: '1М' },
  { days: 90, label: '3М' },
  { days: 180, label: '6М' },
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
          className="absolute right-1 top-1 z-10 rounded border border-transparent p-1 text-muted-foreground transition-colors hover:border-border hover:bg-background hover:text-foreground"
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
export function ChartExpandOverlay({ title, children, renderExpanded, renderExpandedBar, statsFor, statsSum = true, grainable, initialDays, onClose, originRect }: ChartExpandOverlayProps) {
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
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);
  const chartH = regionH ? Math.max(240, regionH - 8) : EXPANDED_CHART_HEIGHT;

  return (
    <DetailShell variant="panel" ariaLabel={`График: ${title}`} onClose={onClose} originRect={originRect}>
        <CardHeader className="shrink-0 pr-12">
          <CardTitle className="text-base font-medium text-foreground">{title}</CardTitle>
          {(renderExpanded || renderExpandedBar) && (
            <div className="flex flex-wrap items-center gap-2 pt-2">
              {renderExpanded &&
                WINDOWS.map((window) => (
                  <button
                    key={window.days}
                    type="button"
                    aria-pressed={days === window.days}
                    onClick={() => setDays(window.days)}
                    className={`whitespace-nowrap border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
                      days === window.days
                        ? 'border-primary text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {window.label}
                  </button>
                ))}
              {grainable && (
                <div role="group" aria-label="Грануляция" className="flex shrink-0 overflow-hidden rounded border border-border">
                  {(['day', 'week', 'month'] as const).map((g) => (
                    <button
                      key={g}
                      type="button"
                      aria-pressed={grain === g}
                      onClick={() => setGrain(g)}
                      className={`border-r border-border px-2.5 py-1.5 text-xs font-medium transition-colors last:border-r-0 ${
                        grain === g ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                      }`}
                    >
                      {g === 'day' ? 'День' : g === 'week' ? 'Неделя' : 'Месяц'}
                    </button>
                  ))}
                </div>
              )}
              {renderExpandedBar && (
                <div role="group" aria-label="Тип графика" className="ml-auto flex shrink-0 overflow-hidden rounded border border-border">
                  <OverlayKindButton kind="line" active={kind === 'line'} onSelect={setKind} />
                  <OverlayKindButton kind="bar" active={kind === 'bar'} onSelect={setKind} />
                </div>
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
                {kind === 'bar' && renderExpandedBar
                  ? renderExpandedBar(days, grain)
                  : renderExpanded
                    ? renderExpanded(days, grain)
                    : children}
              </ExpandedChartHeightContext.Provider>
            </ChartExpandedContext.Provider>
          </div>
          <div className="shrink-0">
            <OverlayStats values={statsFor ? statsFor(days, grain) : null} statsSum={statsSum} />
          </div>
        </CardContent>
    </DetailShell>
  );
}

/** One cell of the overlay's line↔bar toggle — same visual language as the metric-page segment. */
function OverlayKindButton({
  kind,
  active,
  onSelect,
}: {
  kind: 'line' | 'bar';
  active: boolean;
  onSelect: (k: 'line' | 'bar') => void;
}) {
  const label = kind === 'line' ? 'Линия' : 'Столбцы';
  return (
    <button
      type="button"
      aria-pressed={active}
      title={label}
      aria-label={`Тип графика: ${label}`}
      onClick={() => onSelect(kind)}
      className={`flex h-7 w-8 items-center justify-center border-r border-border transition-colors last:border-r-0 ${
        active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
      }`}
    >
      {kind === 'line' ? (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5" aria-hidden="true">
          <path d="M1.5 11.5 5.5 7l3 2.5 5.5-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
          <rect x="2" y="8" width="3" height="6" rx="0.5" />
          <rect x="6.5" y="4" width="3" height="10" rx="0.5" />
          <rect x="11" y="6" width="3" height="8" rx="0.5" />
        </svg>
      )}
    </button>
  );
}

/** Мин · Макс · Среднее (· Сумма) of the visible values — a hairline ledger row under the chart.
    `statsSum={false}` drops the sum for level/stock series where it reads as nonsense. */
function OverlayStats({ values, statsSum = true }: { values: number[] | null; statsSum?: boolean }) {
  if (!values || values.length === 0) return null;
  const sum = values.reduce((s, v) => s + v, 0);
  const rows = [
    { label: 'Мин', value: fmt.short(Math.min(...values)) },
    { label: 'Макс', value: fmt.short(Math.max(...values)) },
    { label: 'Среднее', value: fmt.short(sum / values.length) },
    ...(statsSum ? [{ label: 'Сумма', value: fmt.short(sum) }] : []),
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
