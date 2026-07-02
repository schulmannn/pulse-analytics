import { createContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fmt } from '@/lib/format';
import { useFocusTrap } from '@/lib/useFocusTrap';

/** True while rendering inside the expanded (modal) chart view. Charts opt into richer
    annotations there (full y-axis, value labels) without prop plumbing through the panels. */
export const ChartExpandedContext = createContext(false);

/** Chart height (px) requested by the expanded overlay; null = the caller's own height.
    Overrides the chart's `height` prop, so callers keep their compact inline sizing while
    the same element renders explorer-sized in the modal. */
export const ExpandedChartHeightContext = createContext<number | null>(null);

// steep-style explorer sizing: the overlay chart is markedly taller than any inline card.
const EXPANDED_CHART_HEIGHT = 400;

interface ExpandableChartProps {
  title: string;
  children: ReactNode;
  renderExpanded?: (days: number) => ReactNode;
  /** Bar presentation of the same window — when provided, the overlay grows a line↔bar toggle. */
  renderExpandedBar?: (days: number) => ReactNode;
  /** Values visible in the current window — feeds the Мин/Макс/Среднее/Сумма strip. */
  statsFor?: (days: number) => number[];
  /** Include «Сумма» in the stats strip (default). Off for level/stock series
      (e.g. subscriber counts) where summing the values is meaningless. */
  statsSum?: boolean;
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
 */
export function ExpandableChart({ title, children, renderExpanded, renderExpandedBar, statsFor, statsSum = true }: ExpandableChartProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [days, setDays] = useState(90);

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
        <ExpandedChartDialog
          title={title}
          days={days}
          setDays={setDays}
          renderExpanded={renderExpanded}
          renderExpandedBar={renderExpandedBar}
          statsFor={statsFor}
          statsSum={statsSum}
          onClose={() => setIsOpen(false)}
        >
          {children}
        </ExpandedChartDialog>
      )}
    </>
  );
}

interface ExpandedChartDialogProps extends ExpandableChartProps {
  days: number;
  setDays: (days: number) => void;
  onClose: () => void;
}

/**
 * Expanded chart overlay. Same dialog contract as PostDetailModal:
 * portal, role="dialog" + aria-modal, focus trap, body scroll lock, Escape/backdrop/×
 * to close. The backdrop is semi-transparent paper from the first frame (an opaque
 * black flash is what bg-black/50 produced while the blur composited).
 */
function ExpandedChartDialog({ title, children, renderExpanded, renderExpandedBar, statsFor, statsSum = true, days, setDays, onClose }: ExpandedChartDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Overlay-local presentation; reopening always starts on the line, like metric pages.
  const [kind, setKind] = useState<'line' | 'bar'>('line');
  useFocusTrap(panelRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`График: ${title}`}
    >
      <div className="absolute inset-0 bg-background/70 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <Card
        ref={panelRef}
        tabIndex={-1}
        className="relative z-10 max-h-[90vh] w-full max-w-5xl overflow-y-auto focus:outline-none"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Закрыть"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <CardHeader className="pr-12">
          <CardTitle className="text-base font-medium text-foreground">{title}</CardTitle>
          {(renderExpanded || renderExpandedBar) && (
            <div className="flex flex-wrap items-center gap-2 pt-2">
              {renderExpanded &&
                WINDOWS.map((window) => (
                  <button
                    key={window.days}
                    type="button"
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
              {renderExpandedBar && (
                <div role="group" aria-label="Тип графика" className="ml-auto flex shrink-0 overflow-hidden rounded border border-border">
                  <OverlayKindButton kind="line" active={kind === 'line'} onSelect={setKind} />
                  <OverlayKindButton kind="bar" active={kind === 'bar'} onSelect={setKind} />
                </div>
              )}
            </div>
          )}
        </CardHeader>
        <CardContent>
          {/* No forced svg min-height here: stretching a fixed-viewBox svg with CSS
              distorts the axis/value text vertically in the expanded view. */}
          <ChartExpandedContext.Provider value={true}>
            <ExpandedChartHeightContext.Provider value={EXPANDED_CHART_HEIGHT}>
              <div className="min-h-[420px] w-full">
                {kind === 'bar' && renderExpandedBar
                  ? renderExpandedBar(days)
                  : renderExpanded
                    ? renderExpanded(days)
                    : children}
              </div>
            </ExpandedChartHeightContext.Provider>
          </ChartExpandedContext.Provider>
          <OverlayStats values={statsFor ? statsFor(days) : null} statsSum={statsSum} />
        </CardContent>
      </Card>
    </div>,
    document.body,
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
