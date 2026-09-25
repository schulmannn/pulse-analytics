import type { CSSProperties, ReactNode } from 'react';
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DetailShell } from '@/components/DetailShell';
import { ChartExpandedContext, ExpandedChartHeightContext } from './contexts';

// steep-style explorer sizing: the overlay chart is markedly taller than any inline card.
const EXPANDED_CHART_HEIGHT = 400;

interface ChartExpandOverlayProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
  /** Clicked-card rect for the shared-element grow (forwarded to DetailShell). */
  originRect?: DOMRect | null;
  /** The host widget's accent-token overrides (--brand-iris + chart roles). The overlay lives in
      a portal, OUTSIDE the widget subtree that scopes them — re-declared here (on a
      display:contents wrapper) so the expanded chart keeps the card's accent. */
  accentStyle?: CSSProperties;
}

/**
 * Разворот карточки на месте (`?detail=<id>`) — у карточек БЕЗ `drillTo`. Тело карточки рисуется
 * в полных осях (`ChartExpandedContext`) и в высоте эксплорера; своих окон, типа графика и
 * статистики у оверлея нет: графиковый разбор живёт на маршруте `/metrics/*`, а Tier-2 режим
 * («пилюли периода + Линии + Мин/Макс/Среднее») был недостижим и снесён (EXPAND-17, CHARTS-22).
 *
 * Тот же диалоговый контракт, что у PostDetailModal: портал, role="dialog" + aria-modal,
 * фокус-трап, блокировка прокрутки, Escape/backdrop/× закрывают. Панель сайзится по содержимому
 * (DetailShell fit='content'): короткий список не тащит за собой пустой полноэкранный лист;
 * телефон по-прежнему получает полноэкранный шит — это контракт самого DetailShell.
 */
export function ChartExpandOverlay({ title, children, onClose, originRect, accentStyle }: ChartExpandOverlayProps) {
  return (
    <DetailShell fit="content" ariaLabel={`График: ${title}`} onClose={onClose} originRect={originRect}>
      {/* display:contents — no box of its own (the shell's flex layout is untouched), but the
          custom properties still compute here, carrying the widget accent into the portal. */}
      <div className="contents" style={accentStyle}>
        <CardHeader className="shrink-0 pr-12">
          <CardTitle className="text-base text-foreground">{title}</CardTitle>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col">
          {/* No forced svg min-height here: stretching a fixed-viewBox svg with CSS distorts the
              axis/value text vertically. Content-fit panels do NOT measure this region — with an
              auto-height panel its height FOLLOWS the content, so feeding it back would self-shrink
              chart bodies to the floor; they get the fixed explorer height instead. */}
          <div className="min-h-0 w-full flex-1 overflow-y-auto">
            <ChartExpandedContext.Provider value={true}>
              <ExpandedChartHeightContext.Provider value={EXPANDED_CHART_HEIGHT}>
                {children}
              </ExpandedChartHeightContext.Provider>
            </ChartExpandedContext.Provider>
          </div>
        </CardContent>
      </div>
    </DetailShell>
  );
}
