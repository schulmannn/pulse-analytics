import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LineChart } from './LineChart';

/**
 * D13 (аудит #554): линия IG- и ЯМ-метрики была усыпана кружками на каждом дне, линия TG — чистая.
 * Одна сущность в двух подачах, потому что решение жило НА СТРАНИЦАХ (`values.length <= 45`), а не
 * в графике: сорок пять колец — это комфортные 24px на развороте и 4px на карточке.
 *
 * Правило переехало в LineChart и стало честным: постоянные кольца только там, где точек
 * действительно мало (< 10) и между ними остаётся бумага (шаг ≥ 14px). Всё остальное — ховер,
 * полюса линии, кольца аномалий — не зависит от него и остаётся.
 */

/** Кольца точек — единственные circle с r="3" в разметке. */
const rings = (html: string) => [...html.matchAll(/<circle[^>]*r="3"[^>]*>/g)].length;
const series = (n: number) => Array.from({ length: n }, (_, i) => 1000 + Math.sin(i / 3) * 200 + i);

describe('LineChart: кольца на точках', () => {
  it('короткий ряд получает кольца: восемь замеров читаются как замеры', () => {
    const html = renderToStaticMarkup(<LineChart values={series(8)} showPoints />);
    expect(rings(html)).toBe(8);
  });

  it('дневной ряд колец НЕ получает: тридцать дней — это кривая, а не набор замеров', () => {
    const html = renderToStaticMarkup(<LineChart values={series(30)} showPoints />);
    expect(rings(html)).toBe(0);
  });

  it('девяносто дней тем более: именно там кольца сливались в бусы', () => {
    const html = renderToStaticMarkup(<LineChart values={series(90)} showPoints />);
    expect(rings(html)).toBe(0);
  });

  it('без намерения хоста колец нет и на коротком ряде', () => {
    const html = renderToStaticMarkup(<LineChart values={series(8)} />);
    expect(rings(html)).toBe(0);
  });

  it('полюса линии от правила не зависят: конец ряда помечен всегда', () => {
    const html = renderToStaticMarkup(<LineChart values={series(30)} showPoints />);
    expect(rings(html)).toBe(0);
    // Именно они и отвечают на «где начало и где конец» — ради этого кольца на каждой точке и не нужны.
    expect(html).toContain('data-chart-pole="first"');
    expect(html).toContain('data-chart-pole="last"');
  });
});
