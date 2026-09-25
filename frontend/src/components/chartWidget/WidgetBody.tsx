import type { ReactNode, RefObject } from 'react';
import {
  ChartCardTitleContext,
  ExpandedChartHeightContext,
  WidgetTargetContext,
} from '@/components/ExpandableChart';
import { WidgetErrorBoundary } from '@/components/WidgetErrorBoundary';
import { WidgetPeriodProvider } from '@/lib/period';
import type { WidgetPeriodValue } from '@/lib/period';

interface WidgetBodyProps {
  strip: boolean;
  /** In-flow toolbar header above the body (no floating corner controls to clear). */
  stripToolbar?: boolean;
  reorder: boolean;
  bodyRef: RefObject<HTMLDivElement | null>;
  widgetId: string;
  label: string;
  period: WidgetPeriodValue;
  target: number | null;
  fillHeight: number | null;
  /** Явная высота колонки тела: без неё `flex-1 min-h-0` в авто-высотной full-карточке схлопывается. */
  height?: number;
  /** Фикс-высотный тайл (SIZE_HEIGHT third/half): слот становится size-контейнером `tile`
      (высота задана флексом → containment легален), и height-запросы (tile-short:) работают.
      Авто-высотные full/strip меряются только по ширине. */
  fixedTile: boolean;
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
  height,
  fixedTile,
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
    <div
      className={`${bodyLayout} ${reorder ? 'pointer-events-none' : ''}`}
      style={height ? { height } : undefined}
    >
      <WidgetPeriodProvider value={period}>
        {/* Заголовок карточки — такой же контекст тела, как период и цель, и объявляется здесь же.
            Раньше его публиковал ТОЛЬКО оверлей развёртки (useChartSectionModel → overlayBody), а
            на лицо карточки он не доходил: `ChartCardTitleContext` там оставался `null`, и правило
            «подпись не повторяет заголовок» (D8, аудит #554) молча выключалось на КАЖДОЙ карточке
            продукта. Видно это стало на IG-обзоре — «Охват» печатался и в шапке, и над числом;
            TG-твин выглядел здоровым лишь потому, что гасил подпись руками (`labelHidden`). */}
        <ChartCardTitleContext.Provider value={label}>
        <WidgetTargetContext.Provider value={target}>
          <div ref={bodyRef} className={`min-h-0 flex-1 overflow-hidden ${fixedTile ? 'widget-tile-fixed' : 'widget-tile'}`}>
            <WidgetErrorBoundary variant="inline" widgetId={widgetId} label={label} resetKeys={resetKeys}>
              <ExpandedChartHeightContext.Provider value={fillHeight}>
                {primary}
              </ExpandedChartHeightContext.Provider>
            </WidgetErrorBoundary>
          </div>
          {footer != null && <div className="shrink-0">{footer}</div>}
        </WidgetTargetContext.Provider>
        </ChartCardTitleContext.Provider>
      </WidgetPeriodProvider>
    </div>
  );
}
