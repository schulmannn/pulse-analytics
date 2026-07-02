import { createContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useFocusTrap } from '@/lib/useFocusTrap';

/** True while rendering inside the expanded (modal) chart view. Charts opt into richer
    annotations there (value labels, y ticks) without prop plumbing through the panels. */
export const ChartExpandedContext = createContext(false);

interface ExpandableChartProps {
  title: string;
  children: ReactNode;
  renderExpanded?: (days: number) => ReactNode;
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
export function ExpandableChart({ title, children, renderExpanded }: ExpandableChartProps) {
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
 * Expanded chart overlay. Same dialog contract as PostDetailModal/KpiDrillDown:
 * portal, role="dialog" + aria-modal, focus trap, body scroll lock, Escape/backdrop/×
 * to close. The backdrop is semi-transparent paper from the first frame (an opaque
 * black flash is what bg-black/50 produced while the blur composited).
 */
function ExpandedChartDialog({ title, children, renderExpanded, days, setDays, onClose }: ExpandedChartDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
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
          {renderExpanded && (
            <div className="flex flex-wrap pt-2">
              {WINDOWS.map((window) => (
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
            </div>
          )}
        </CardHeader>
        <CardContent>
          {/* No forced svg min-height here: stretching a fixed-viewBox svg with CSS
              distorts the axis/value text vertically in the expanded view. */}
          <ChartExpandedContext.Provider value={true}>
            <div className="min-h-[280px] w-full">
              {renderExpanded ? renderExpanded(days) : children}
            </div>
          </ChartExpandedContext.Provider>
        </CardContent>
      </Card>
    </div>,
    document.body,
  );
}
