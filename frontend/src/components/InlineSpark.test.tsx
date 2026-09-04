import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InlineSpark } from './InlineSpark';

/**
 * D17 (аудит #554): искра рисовала УРОВЕНЬ вместо ФОРМЫ.
 *
 * Домен строился от нуля (`max(...values, 1)`), поэтому доля около 30% ± 3 превращалась в почти
 * прямую у верхней трети — то есть искра повторяла число, написанное рядом, вместо того чтобы
 * показать динамику. На 16px высоты и 30 точках это читалось зигзагом-каракулей.
 */
const ys = (html: string) => {
  const d = html.match(/ d="([^"]*)"/)?.[1] ?? '';
  return [...d.matchAll(/[-\d.]+\s+([-\d.]+)/g)].map((m) => Number(m[1]));
};
const spread = (html: string) => {
  const y = ys(html);
  return y.length ? Math.max(...y) - Math.min(...y) : 0;
};

describe('InlineSpark', () => {
  it('домен берётся по данным: малый размах вокруг высокого уровня ВИДЕН', () => {
    // Ровно случай «Качества трафика»: 30% ± 3. От нуля это плоская линия.
    const values = [30, 33, 29, 31, 27, 32, 28];
    const html = renderToStaticMarkup(<InlineSpark values={values} height={20} />);
    // Линия занимает почти всю высоту поля (20 − 2·pad = 16), а не 10% от неё.
    expect(spread(html)).toBeGreaterThan(12);
  });

  it('ряд без динамики не рисуется: прямая в тексте читается зачёркиванием', () => {
    expect(renderToStaticMarkup(<InlineSpark values={[100, 100, 100, 100]} />)).toBe('');
  });

  it('плотный ряд сглаживается скользящим окном', () => {
    // 30 точек на 72px — шаг 2.4px: без сглаживания кубическая кривая даёт зигзаг.
    const noisy = Array.from({ length: 30 }, (_, i) => 30 + (i % 2 ? 3 : -3));
    const html = renderToStaticMarkup(<InlineSpark values={noisy} width={72} height={20} />);
    expect(html).toContain('data-spark-smoothed');
  });

  it('короткий ряд не сглаживается — там каждая точка это день', () => {
    const html = renderToStaticMarkup(<InlineSpark values={[10, 40, 20, 50, 30, 60, 25]} />);
    expect(html).not.toContain('data-spark-smoothed');
  });

  it('меньше двух точек и нечисловые значения не рисуют ничего', () => {
    expect(renderToStaticMarkup(<InlineSpark values={[42]} />)).toBe('');
    expect(renderToStaticMarkup(<InlineSpark values={[Number.NaN, Number.POSITIVE_INFINITY]} />)).toBe('');
  });

  it('в геометрию не попадают NaN/Infinity', () => {
    const html = renderToStaticMarkup(<InlineSpark values={[10, 20, 30, 40]} />);
    expect(html).not.toMatch(/NaN|Infinity/);
  });
});
