import type { ReactNode, RefObject } from 'react';
import { ExpandedChartHeightContext, WidgetTargetContext } from '@/components/ExpandableChart';
import { WidgetErrorBoundary } from '@/components/WidgetErrorBoundary';
import { WidgetPeriodProvider } from '@/lib/period';
import type { WidgetPeriodValue } from '@/lib/period';

interface WidgetBodyProps {
  strip: boolean;
  /** In-flow toolbar header above the body (no floating corner controls to clear). */
  stripToolbar?: boolean;
  reorder: boolean;
  bodyRef: RefObject<HTMLDivElement>;
  widgetId: string;
  label: string;
  period: WidgetPeriodValue;
  target: number | null;
  fillHeight: number | null;
  primary: ReactNode;
  footer?: ReactNode;
  resetKeys: unknown[];
}

/** Provider and error-boundary shell around the card's renderable body. */
export function WidgetBody({
  strip,
  stripToolbar,
  reorder,
  bodyRef,
  widgetId,
  label,
  period,
  target,
  fillHeight,
  primary,
  footer,
  resetKeys,
}: WidgetBodyProps) {
  // Floating strip reserves `pr-8` for its corner controls; a toolbar strip has an in-flow header
  // above it, so it just needs the standard top gap (like a non-strip card body).
  const bodyLayout = strip
    ? stripToolbar
      ? 'mt-3 flex min-h-0 flex-col'
      : 'flex min-h-0 flex-col pr-8'
    : 'mt-3 flex min-h-0 flex-1 flex-col';
  return (
    <div className={`${bodyLayout} ${reorder ? 'pointer-events-none' : ''}`}>
      <WidgetPeriodProvider value={period}>
        <WidgetTargetContext.Provider value={target}>
          <div ref={bodyRef} className="min-h-0 flex-1 overflow-hidden">
            <WidgetErrorBoundary variant="inline" widgetId={widgetId} label={label} resetKeys={resetKeys}>
              <ExpandedChartHeightContext.Provider value={fillHeight}>
                {primary}
              </ExpandedChartHeightContext.Provider>
            </WidgetErrorBoundary>
          </div>
          {footer != null && <div className="shrink-0">{footer}</div>}
        </WidgetTargetContext.Provider>
      </WidgetPeriodProvider>
    </div>
  );
}
