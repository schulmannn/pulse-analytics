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
  /**
   * Явная высота тела — для full-карточек С ГРАФИКОМ (аудит #554, D15).
   *
   * `SIZE_HEIGHT.full` пустая намеренно: полноширинная карточка с леджером или таблицей растёт
   * по содержимому. Но тело карточки — это `flex-1 min-h-0` в КОЛОНКЕ БЕЗ ВЫСОТЫ, а такой элемент
   * по спеке флекса получает базис 0 и схлопывается. График внутри меряет хост, видит крошки и падает
   * в свой минимум — замерено на «Упоминаниях по дням»: карточка 164px, тело 81px, svg 60px
   * (пол), тогда как любая фикс-карточка рядом отдаёт графику 161–181px.
   */
  chartHeight?: number;
  /** Rich fullscreen explorer configuration. */
  expand?: ChartExpandConfig;
  /** Dedicated metric route used by every expand affordance when present. */
  drillTo?: string;
  /** Removes every expand affordance for views that are already expanded. */
  noExpand?: boolean;
  /** Карточка НЕ участвует в закрытии хвостового пробела ряда (WidgetGroup растягивает одиночку
      последнего ряда на всю ширину). Ставить там, где содержимое шириной не пользуется — дуга,
      разбивка, недельная семёрка столбцов: растянутая на 1110px карточка даёт не «широкий
      график», а маленький график посреди пустоты. */
  noStretch?: boolean;
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
