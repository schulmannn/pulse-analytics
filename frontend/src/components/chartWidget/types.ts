import type { ReactNode } from 'react';
import type { ChartExpandConfig } from '@/components/ExpandableChart';
import type { WidgetPeriodValue } from '@/lib/period';
import type { WidgetSeriesOpts, WidgetSize } from '@/lib/widgetPrefsStore';
import type { WidgetVariant } from '@/components/widgets/variants';

export interface ConfigWidgetEditor {
  open: () => void;
  color?: number;
  tinted?: boolean;
  size?: WidgetSize;
  target?: number | null;
}

export interface ChartSectionProps {
  /** Stable widget id for the prefs store; defaults to the title. */
  id?: string;
  title: string;
  /** Extra header controls between the title and the menu. */
  action?: ReactNode;
  /** Presentations selectable in the edit dialog, optionally derived for this widget's period. */
  variants?: WidgetVariant[] | ((period: WidgetPeriodValue, series: WidgetSeriesOpts) => WidgetVariant[]);
  className?: string;
  defaultSize?: WidgetSize;
  /** Metric-identity accent used until the user chooses a colour explicitly. */
  defaultColor?: number;
  /** Locks the surface size and hides the size control in the editor. */
  fixedSize?: WidgetSize;
  /** Rich fullscreen explorer configuration. */
  expand?: ChartExpandConfig;
  /** Dedicated metric route used by every expand affordance when present. */
  drillTo?: string;
  /** Removes every expand affordance for views that are already expanded. */
  noExpand?: boolean;
  /** Marks a period-aware body. Feed pages use their top bar; Home exposes the widget's own value. */
  periodControl?: boolean;
  /** Thin full-width summary row without card chrome. */
  strip?: boolean;
  /** Personal Home registry key used by the pin/unpin command. */
  homeKey?: string;
  /** Enables grain, include-today, and target controls for compatible series widgets. */
  seriesOptions?: boolean;
  /** Overrides prefs-backed editing for config-driven widgets. */
  configEditor?: ConfigWidgetEditor;
  /** Custom fullscreen explorer that replaces ChartExpandOverlay. */
  explorer?: (close: () => void, originRect?: DOMRect | null) => ReactNode;
  /** Clears the body error boundary when the widget's data/config identity changes. */
  bodyResetKey?: unknown;
  children?: ReactNode;
}
