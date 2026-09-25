import { Suspense, lazy, type CSSProperties, type ReactNode } from 'react';
import { ChartExpandOverlay } from '@/components/ExpandableChart';
import { WidgetErrorBoundary } from '@/components/WidgetErrorBoundary';
import { lazyWithReload } from '@/lib/lazyWithReload';
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
  defaultColor?: number;
  /** Resolved «цветной фон» default for this card — keeps the switch honest about what the
      un-touched card actually shows. */
  defaultTinted: boolean;
  minSize: WidgetSize;
  onChange: (next: WidgetPrefs) => void;
  onClose: () => void;
}

/**
 * Редактор карточки — ЗА ЛЕНИВОЙ ГРАНИЦЕЙ. Он открывается по действию из меню карточки, а
 * статический импорт держал его (вместе с ui/switch, ui/swatch-button и целым ui/select) в чанке
 * каждого маршрута с графиками. Граница напрашивалась сама: оверлей и так возвращает null, пока
 * закрыт, — мешала только константа WIDGET_PERIODS, которую строка пилюль тянула из этого же
 * модуля (переехала в chartWidget/constants).
 */
const EditWidgetDialog = lazy(
  lazyWithReload(() =>
    import('@/components/widgets/EditWidgetDialog').then((m) => ({ default: m.EditWidgetDialog })),
  ),
);

export function WidgetEditOverlay({ open, configDriven, ...props }: WidgetEditOverlayProps) {
  if (!open || configDriven) return null;
  return (
    <Suspense fallback={null}>
    <EditWidgetDialog
      defaultTitle={props.title}
      prefs={props.prefs}
      variants={props.variants}
      showPeriod={props.periodControl}
      showSeries={props.seriesOptions}
      showSource={props.showSource}
      showSize={props.showSize}
      defaultSize={props.defaultSize}
      defaultColor={props.defaultColor}
      defaultTinted={props.defaultTinted}
      minSize={props.minSize}
      onChange={props.onChange}
      onClose={props.onClose}
    />
    </Suspense>
  );
}

interface WidgetExpandOverlayProps {
  open: boolean;
  noExpand: boolean;
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
  if (noExpand) return null;

  return (
    <ChartExpandOverlay
      title={label}
      accentStyle={accentStyle ?? undefined}
      // A rich explorer owns window controls even when the working page suppresses card-local
      // period controls. Seed it from the authoritative page/widget window; otherwise opening a
      // 30-day MoySklad/TG/IG card silently highlighted the overlay's 90-day fallback.
      initialDays={richExpand || periodControl ? days : undefined}
      renderExpanded={richExpand ? expand?.renderExpanded : undefined}
      renderExpandedBar={richExpand ? expand?.renderExpandedBar : undefined}
      statsFor={richExpand ? expand?.statsFor : undefined}
      statsSum={expand?.statsSum ?? true}
      grainable={richExpand ? expand?.grainable : undefined}
      extraControls={richExpand ? expand?.extraControls : undefined}
      onClose={onClose}
      originRect={originRect}
    >
      <WidgetErrorBoundary variant="inline" widgetId={widgetId} label={label} resetKeys={resetKeys}>
        {body}
      </WidgetErrorBoundary>
    </ChartExpandOverlay>
  );
}
