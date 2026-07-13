import type { CSSProperties, ReactNode } from 'react';
import { ChartExpandOverlay } from '@/components/ExpandableChart';
import { WidgetErrorBoundary } from '@/components/WidgetErrorBoundary';
import { EditWidgetDialog } from '@/components/widgets/EditWidgetDialog';
import type { ChartExpandConfig } from '@/components/ExpandableChart';
import type { PeriodDays } from '@/lib/period';
import type { WidgetPrefs, WidgetSize } from '@/lib/widgetPrefsStore';
import type { WidgetVariant } from '@/components/widgets/variants';

interface WidgetEditOverlayProps {
  open: boolean;
  configDriven: boolean;
  title: string;
  prefs: WidgetPrefs;
  variants: WidgetVariant[] | undefined;
  periodControl: boolean;
  seriesOptions: boolean;
  showSource: boolean;
  showSize: boolean;
  defaultSize: WidgetSize;
  minSize: WidgetSize;
  onChange: (next: WidgetPrefs) => void;
  onClose: () => void;
}

export function WidgetEditOverlay({ open, configDriven, ...props }: WidgetEditOverlayProps) {
  if (!open || configDriven) return null;
  return (
    <EditWidgetDialog
      defaultTitle={props.title}
      prefs={props.prefs}
      variants={props.variants}
      showPeriod={props.periodControl}
      showSeries={props.seriesOptions}
      showSource={props.showSource}
      showSize={props.showSize}
      defaultSize={props.defaultSize}
      minSize={props.minSize}
      onChange={props.onChange}
      onClose={props.onClose}
    />
  );
}

interface WidgetExpandOverlayProps {
  open: boolean;
  noExpand: boolean;
  customExplorer?: (close: () => void, originRect?: DOMRect | null) => ReactNode;
  onClose: () => void;
  originRect: DOMRect | null;
  widgetId: string;
  label: string;
  accentStyle: CSSProperties | null;
  periodControl: boolean;
  days: PeriodDays;
  expand?: ChartExpandConfig;
  richExpand: boolean;
  resetKeys: unknown[];
  body: ReactNode;
}

export function WidgetExpandOverlay({
  open,
  noExpand,
  customExplorer,
  onClose,
  originRect,
  widgetId,
  label,
  accentStyle,
  periodControl,
  days,
  expand,
  richExpand,
  resetKeys,
  body,
}: WidgetExpandOverlayProps) {
  if (!open) return null;
  if (customExplorer) return <>{customExplorer(onClose, originRect)}</>;
  if (noExpand) return null;

  return (
    <ChartExpandOverlay
      title={label}
      accentStyle={accentStyle ?? undefined}
      initialDays={periodControl ? days : undefined}
      renderExpanded={richExpand ? expand?.renderExpanded : undefined}
      renderExpandedBar={richExpand ? expand?.renderExpandedBar : undefined}
      statsFor={richExpand ? expand?.statsFor : undefined}
      statsSum={expand?.statsSum ?? true}
      grainable={richExpand ? expand?.grainable : undefined}
      onClose={onClose}
      originRect={originRect}
    >
      <WidgetErrorBoundary variant="inline" widgetId={widgetId} label={label} resetKeys={resetKeys}>
        {body}
      </WidgetErrorBoundary>
    </ChartExpandOverlay>
  );
}
