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
  minSize?: WidgetSize;
  onSizeChange?: (size: WidgetSize) => void;
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
  /** Opt-in accent-tinted surface until the user decides otherwise. Canon: at most ONE tinted
      story card per page — every other card defaults to a neutral surface (DESIGN_TOKENS.md
      «Surface & width policy»). Meaningful only together with `defaultColor`. */
  defaultTinted?: boolean;
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
  /** Renders the strip header in-flow as a visible title + action toolbar (instead of the default
      floating sr-only header). Opt-in, page-scoped — the metric explorer wraps such a strip in its
      own card shell so the title/switcher/menu read as one toolbar. */
  stripToolbar?: boolean;
  /** Personal Home registry key used by the pin/unpin command. */
  homeKey?: string;
  /** Прогрессивная загрузка вне Главной: тело карточки не фетчит, пока карточка не подойдёт к
      вьюпорту (тот же механизм, что у `homeKey`-карточек доски — WidgetInViewContext). Явный
      opt-in, а не вывод из `drillTo`: `drillTo` есть и у общих тел (история/тепловая карта/
      скорость/топ-посты/упоминания), которые уже читают контекст и на рабочих страницах обязаны
      грузиться сразу. Работает только если тело реально читает `useWidgetInView()`. */
  deferData?: boolean;
  /** Enables grain, include-today, and target controls for compatible series widgets. */
  seriesOptions?: boolean;
  /** Overrides prefs-backed editing for config-driven widgets. */
  configEditor?: ConfigWidgetEditor;
  /** Clears the body error boundary when the widget's data/config identity changes. */
  bodyResetKey?: unknown;
  children?: ReactNode;
}
