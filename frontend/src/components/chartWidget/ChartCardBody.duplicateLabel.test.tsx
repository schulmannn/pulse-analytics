import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChartCardBody } from './ChartCardBody';
import { ChartCardTitleContext } from '@/components/ExpandableChart';

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
