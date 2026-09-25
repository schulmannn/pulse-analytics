import { useContext } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChartExpandOverlay } from './ChartExpandOverlay';
import {
  ChartCardTitleContext,
  ChartExpandedContext,
  ExpandedChartHeightContext,
  WidgetTargetContext,
} from './contexts';
import type { ChartSectionProps } from './types';

/**
 * Разворот карточки на месте (`?detail=`) после сноса rich-режима (EXPAND-17, CHARTS-22).
 *
 * Пришпилено:
 *  • тело карточки получает те же контексты, что и раньше (полные оси, высота эксплорера 400);
 *  • панель сайзится по содержимому — оверлей больше не бывает полноэкранным «эксплорером»;
 *  • в оверлее нет ни окон, ни грануляции, ни типа графика, ни «Линий», ни строки
 *    Мин/Макс/Среднее/Сумма: графиковый разбор живёт на маршруте /metrics/*;
 *  • у ChartSection нет пропа `expand` — конфиг, который никогда не рендерился, не компилируется.
 *
 * DetailShell — Radix-портал, которого нет в node-рендере, поэтому здесь он заменён прозрачной
 * обёрткой, которая печатает то, что оверлей ему передал.
 */
vi.mock('@/components/DetailShell', () => ({
  DetailShell: ({ ariaLabel, fit, children }: { ariaLabel: string; fit?: string; children: ReactNode }) => (
    <div data-shell-label={ariaLabel} data-shell-fit={fit ?? 'viewport'}>
      {children}
    </div>
  ),
}));

function Probe() {
  const expanded = useContext(ChartExpandedContext);
  const height = useContext(ExpandedChartHeightContext);
  const target = useContext(WidgetTargetContext);
  const title = useContext(ChartCardTitleContext);
  return (
    <span
      data-probe=""
      data-expanded={String(expanded)}
      data-height={String(height)}
      data-target={String(target)}
      data-title={String(title)}
    />
  );
}

const renderOverlay = (accentStyle?: CSSProperties) =>
  renderToStaticMarkup(
    <ChartExpandOverlay title="Лучшие публикации" onClose={() => {}} accentStyle={accentStyle}>
      <Probe />
    </ChartExpandOverlay>,
  );

describe('контексты карточки — значения по умолчанию', () => {
  it('вне оверлея и карточки график рисуется в своей высоте, без осей разворота, цели и заголовка', () => {
    const html = renderToStaticMarkup(<Probe />);
    expect(html).toContain('data-expanded="false"');
    expect(html).toContain('data-height="null"');
    expect(html).toContain('data-target="null"');
    expect(html).toContain('data-title="null"');
  });
});

describe('ChartExpandOverlay — Tier-1 разворот на месте', () => {
  it('тело получает полные оси и высоту эксплорера', () => {
    const html = renderOverlay();
    expect(html).toContain('data-expanded="true"');
    expect(html).toContain('data-height="400"');
  });

  it('диалог называется «График: …» и сайзится по содержимому', () => {
    const html = renderOverlay();
    expect(html).toContain('data-shell-label="График: Лучшие публикации"');
    expect(html).toContain('data-shell-fit="content"');
    expect(html).toContain('>Лучшие публикации<');
  });

  it('rich-эксплорер не воскресает: ни окон, ни грануляции, ни типа графика, ни «Линий», ни статистики', () => {
    const html = renderOverlay();
    for (const word of ['Окно', 'Грануляция', 'Тип графика', 'Линии', 'Мин', 'Макс', 'Среднее', 'Сумма', 'к пред. периоду']) {
      expect(html).not.toContain(word);
    }
    expect(html).not.toContain('<button');
    expect(html).not.toContain('aria-pressed');
    // Кроме заголовка карточки и её тела в оверлее ничего нет.
    expect(html.match(/data-probe=""/g)).toHaveLength(1);
  });

  it('акцент карточки переносится в портал на display:contents-обёртке', () => {
    const html = renderOverlay({ '--brand-iris': 'var(--chart-3-accent)' } as CSSProperties);
    expect(html).toContain('class="contents" style="--brand-iris:var(--chart-3-accent)"');
  });
});

describe('ChartSection — без rich-конфига', () => {
  it('проп expand снят: карточка раскрывается маршрутом drillTo или оверлеем на месте', () => {
    const props: ChartSectionProps = {
      title: 'Просмотры',
      drillTo: '/metrics/views',
      // @ts-expect-error — rich-разворот снесён (EXPAND-17): конфиг, который никогда не рендерился, не компилируется.
      expand: { statsFor: () => [] },
    };
    expect(props.drillTo).toBe('/metrics/views');
  });
});
