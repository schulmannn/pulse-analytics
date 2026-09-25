import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ChartCardBody } from './ChartCardBody';
import { ChartSection } from './ChartSection';
import { ChartCardTitleContext } from '@/components/ExpandableChart';
import { PeriodProvider } from '@/lib/period';

/**
 * D8 (аудит #554): подпись внутри карточки повторяла её заголовок.
 *
 * На IG-обзоре карточка называлась «Охват», и над числом 147.1k стояла ВТОРАЯ подпись «Охват».
 * Это уже вторая серия одного дефекта — до неё так же дублировались «Просмотры» (аудит 11
 * августа), — поэтому правило живёт в теле карточки, а не в каждом её вызывающем.
 */
const render = (title: string | null, label?: string) =>
  renderToStaticMarkup(
    <ChartCardTitleContext.Provider value={title}>
      <ChartCardBody label={label} value="147.1k">{null}</ChartCardBody>
    </ChartCardTitleContext.Provider>,
  );

const headlineText = (html: string) =>
  [...html.matchAll(/<div class="text-xs tracking-wide text-muted-foreground">([^<]*)<\/div>/g)].map((m) => m[1]);

describe('ChartCardBody: подпись не дублирует заголовок карточки', () => {
  it('подпись, равная заголовку, не печатается вовсе', () => {
    expect(headlineText(render('Охват', 'Охват'))).toEqual([]);
  });

  it('регистр не спасает дубль', () => {
    expect(headlineText(render('Охват', 'охват'))).toEqual([]);
  });

  it('от «заголовок · окно» остаётся только окно', () => {
    // «Охват · 30 дн.» под карточкой «Охват» несёт ровно одну новую вещь — длину окна.
    expect(headlineText(render('Охват', 'Охват · 30 дн.'))).toEqual(['30 дн.']);
    expect(headlineText(render('Подписчики', 'База · 30 дн.'))).toEqual(['База · 30 дн.']);
  });

  it('своя подпись остаётся как есть', () => {
    expect(headlineText(render('Охват', 'за 30 дн.'))).toEqual(['за 30 дн.']);
  });

  it('без заголовка карточки подпись печатается без изменений', () => {
    expect(headlineText(render(null, 'Охват'))).toEqual(['Охват']);
  });

  it('пустая подпись не рисует пустую строку', () => {
    expect(headlineText(render('Охват'))).toEqual([]);
  });
});

/**
 * Правило выше с самого своего появления было мёртвым на ЛИЦЕ карточки, и тесты этого не видели:
 * они сами подавали `ChartCardTitleContext`, которого в проде там не было. Заголовок публиковал
 * ТОЛЬКО оверлей развёртки (useChartSectionModel → overlayBody), а лицо жило с `null` — и D8 молча
 * отключался на каждой карточке продукта. На IG-обзоре это и увидел владелец: карточка «Охват»
 * печатала «Охват» в шапке и второй раз над числом 146.4k. TG-твин «Просмотры» выглядел здоровым
 * не потому, что правило работало, а потому что гасил подпись руками (FeaturedKpi.labelHidden).
 *
 * Поэтому гейт идёт через НАСТОЯЩУЮ композицию ChartSection → WidgetBody → ChartCardBody: контекст
 * не подставляется тестом, а обязан прийти от карточки.
 */
const renderCard = (title: string, label?: string) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <PeriodProvider>
        <ChartSection id="ig-overview-reach" title={title}>
          <ChartCardBody label={label} value="146.4k">{null}</ChartCardBody>
        </ChartSection>
      </PeriodProvider>
    </MemoryRouter>,
  );

describe('ChartSection: лицо карточки объявляет свой заголовок телу', () => {
  it('подпись, равная заголовку карточки, не печатается (IG-обзор, «Охват»)', () => {
    const html = renderCard('Охват', 'Охват');
    expect(headlineText(html)).toEqual([]);
    // Заголовок при этом обязан остаться на месте: дубль снимается подписью, а не шапкой.
    expect(html).toContain('>Охват</h3>');
  });

  it('от «заголовок · окно» на лице остаётся только окно', () => {
    // Та же карточка на Главной: страничного периода нет, подпись несёт окно (useCardShowsPeriod).
    expect(headlineText(renderCard('Охват', 'Охват · 30 дн.'))).toEqual(['30 дн.']);
  });

  it('своя подпись на лице остаётся как есть', () => {
    // «Динамика аудитории» со своей подписью «База · 30 дн.» — не дубль, трогать нечего.
    expect(headlineText(renderCard('Динамика аудитории', 'База · 30 дн.'))).toEqual(['База · 30 дн.']);
  });
});
