import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DivergingBars } from './DivergingBars';

describe('DivergingBars accessibility contract', () => {
  it('names the passive SVG with exact extrema and latest value', () => {
    const html = renderToStaticMarkup(
      <DivergingBars
        values={[12, -4, 0]}
        labels={['1 июл.', '2 июл.', '3 июл.']}
        titles={['рост 12', 'снижение 4', 'без изменений']}
      />,
    );

    expect(html).toContain('role="img"');
    expect(html).toMatch(/aria-labelledby="[^"]+"/);
    expect(html).toContain('<title');
    expect(html).toContain('Минимум -4; максимум 12.');
    expect(html).toContain('Последняя — 3 июл.: 0 (без изменений).');
  });

  it('keeps the accessible name bounded for long histories', () => {
    const values = Array.from({ length: 365 }, (_, index) => index - 180);
    const html = renderToStaticMarkup(
      <DivergingBars
        values={values}
        labels={values.map((_, index) => `день ${index + 1}`)}
      />,
    );
    const title = html.match(/<title[^>]*>([^<]+)<\/title>/)?.[1] ?? '';

    expect(title).toContain('Дельта по 365 точкам.');
    expect(title).toContain('Минимум -180; максимум 184.');
    expect(title).toContain('Последняя — день 365: 184.');
    expect(title.length).toBeLessThan(220);
  });

  it('keeps non-finite samples out of SVG geometry and readouts', () => {
    const html = renderToStaticMarkup(
      <DivergingBars
        values={[12, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]}
        labels={['finite', 'nan', 'positive infinity', 'negative infinity']}
      />,
    );

    expect(html).toContain('Минимум 12; максимум 12.');
    expect(html).toContain('Последняя — negative infinity: нет данных.');
    expect(html).not.toMatch(/NaN|Infinity/);
    expect(html).not.toMatch(/\b(?:x|y|width|height)="[^"]*(?:NaN|Infinity)/);
  });

  it('shows an empty state when every sample is non-finite', () => {
    const html = renderToStaticMarkup(
      <DivergingBars
        values={[Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]}
        labels={['nan', 'positive infinity', 'negative infinity']}
      />,
    );

    expect(html).toContain('Нет данных');
    expect(html).not.toContain('role="img"');
    expect(html).not.toContain('cursor-crosshair');
  });
});
