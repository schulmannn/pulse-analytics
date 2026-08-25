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

    // aria-label вместо svg <title> — канон LineChart/BarChart: у <title> есть побочный нативный
    // браузерный тултип (нестилизуемый прямоугольник с острыми углами поверх ChartTooltip).
    expect(html).toContain('role="img"');
    expect(html).toMatch(/aria-label="[^"]+"/);
    expect(html).not.toContain('<title');
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
    const label = html.match(/aria-label="([^"]+)"/)?.[1] ?? '';

    expect(label).toContain('Дельта по 365 точкам.');
    expect(label).toContain('Минимум -180; максимум 184.');
    expect(label).toContain('Последняя — день 365: 184.');
    expect(label.length).toBeLessThan(220);
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

  it('keeps the accessible name categorical when the axis is not time', () => {
    const html = renderToStaticMarkup(
      <DivergingBars
        axis="category"
        values={[-10, -250, -30]}
        labels={['Ozon', 'Яндекс.Маркет', 'Wildberries']}
        titles={['Ozon: −10', 'Яндекс.Маркет: −250', 'Wildberries: −30']}
      />,
    );

    // «Последняя точка» на разрезах — ложь: порядок задаёт сортировка, а не время.
    expect(html).toContain('Дельта по 3 разрезам.');
    expect(html).not.toContain('Последняя');
    expect(html).toContain('Наибольший вклад — Яндекс.Маркет');
  });
});

/**
 * Нулевая линия — линейная шкала по НАСТОЯЩЕМУ размаху, а не половина высоты.
 *
 * Прежний `mid = h / 2` резервировал половину поля под знак, которого в данных может не быть:
 * на разборе «Что изменило выручку» все вклады ушли в минус, верх карточки пустовал всегда, а
 * столбцы делили оставшуюся половину и вырождались в полоски (жалоба владельца).
 *
 * Числа тут точные и потому проверяемые: высота по умолчанию 120, полоса подписей 20 → h = 100,
 * поля по 4px сверху и снизу → на столбцы остаётся 92.
 */
describe('DivergingBars zero line follows the data', () => {
  const zeroLineY = (html: string) => Number(html.match(/<line[^>]*y1="([\d.]+)"/)?.[1]);
  const bars = (values: number[], extra?: Record<string, unknown>) =>
    renderToStaticMarkup(
      <DivergingBars values={values} labels={values.map((_, i) => `p${i}`)} {...extra} />,
    );

  it('gives the whole height to the only sign present — all negative', () => {
    const html = bars([-100, -50, -10]);
    expect(zeroLineY(html)).toBe(4);
    // Самый глубокий столбец достаёт до нижнего поля: 4 + 92 = 96.
    expect(html).toMatch(/[QLM]\s*[\d.]+\s+96\b/);
  });

  it('gives the whole height to the only sign present — all positive', () => {
    expect(zeroLineY(bars([10, 20, 5]))).toBe(96);
  });

  it('keeps the classic midline for a symmetric spread', () => {
    expect(zeroLineY(bars([10, -10]))).toBe(50);
  });

  it('splits the height by the real up/down ratio', () => {
    // maxUp 12, maxDown 4 → верх забирает 12/16 поля: 4 + 92 · 0.75 = 73.
    expect(zeroLineY(bars([12, -4]))).toBe(73);
  });

  it('degenerates to the midline when there is nothing to scale', () => {
    expect(zeroLineY(bars([0, 0]))).toBe(50);
  });
});

describe('DivergingBars value labels', () => {
  it('prints the caller-formatted values and drops the current-pill on a categorical axis', () => {
    const html = renderToStaticMarkup(
      <DivergingBars
        axis="category"
        values={[-10, -250, -30]}
        labels={['Ozon', 'Яндекс.Маркет', 'Wildberries']}
        valueLabels={['−10к', '−250к', '−30к']}
      />,
    );

    expect(html).toContain('−250к');
    expect(html).toContain('data-chart-value-label');
    // Пилюля «текущего» на разрезах читалась бы как «этот выбран» — её нет.
    expect(html).not.toContain('data-axis-current');
  });

  it('keeps the current-pill on a time axis', () => {
    const html = renderToStaticMarkup(
      <DivergingBars values={[1, -2, 3]} labels={['1 июл.', '2 июл.', '3 июл.']} />,
    );
    expect(html).toContain('data-axis-current');
  });

  it('omits a value that would not fit its column', () => {
    const values = Array.from({ length: 40 }, (_, i) => i - 20);
    const html = renderToStaticMarkup(
      <DivergingBars
        axis="category"
        values={values}
        labels={values.map((_, i) => `p${i}`)}
        valueLabels={values.map((v) => `${v} ₽`)}
      />,
    );
    // 600px на 40 столбцов — 15px на подпись: «−20 ₽» туда не влезает, и обрезок хуже пропуска.
    expect(html).not.toContain('data-chart-value-label');
  });
});

describe('DivergingBars degenerate input', () => {
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
