import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BarChart } from './BarChart';

/**
 * ОРИЕНТИР-СРЕДНЕЕ НА СТОЛБЦАХ (R8, референс Mercury Insights).
 *
 * Столбец отвечает «сколько в этот день», но не отвечает «это выше или ниже обычного»: глаз
 * сравнивает соседние столбцы, а не всё окно. Линия среднего делает сравнение с окном видимым,
 * не добавляя ни одного числа в шапку.
 *
 * Три вещи, которые здесь пришпилены:
 *  • линия рисуется по пропу (до правки её нельзя было поставить снаружи вовсе — ориентиры жили
 *    только в контекстах: цель виджета и «Линии» разворота);
 *  • `vector-effect="non-scaling-stroke"` — обязателен по CLAUDE.md для любой обводки в
 *    растягиваемом viewBox, иначе штрих «размазывает»;
 *  • ДОМЕН включает уровень линии: среднее считается по ПОЛНОМУ окну, а столбцы могут прийти
 *    прорежёнными (LTTB), поэтому уровень способен оказаться выше видимого максимума — и тогда
 *    линия ушла бы за кадр.
 */
const render = (values: number[], referenceLine?: { value: number; label: string }) =>
  renderToStaticMarkup(<BarChart values={values} labels={values.map((_, i) => `д${i}`)} referenceLine={referenceLine} />);

/** Верхняя кромка САМОГО ВЫСОКОГО столбца (y растёт вниз): по ней и читается домен — столбец,
    равный максимуму домена, начинается у нуля. Столбцы — пути, их вершина стоит в «M x y». */
const tallestBarTop = (html: string) =>
  Math.min(
    ...[...html.matchAll(/data-chart-series="current"[^>]*\sd="M [\d.]+ ([\d.]+)/g)].map((m) => Number(m[1])),
  );

/** y пунктирного ориентира — чтобы увидеть, что он остался внутри полотна. */
const refLineY = (html: string) => Number(/data-chart-ref-line[\s\S]*?<line[^>]*y1="([-\d.]+)"/.exec(html)?.[1]);

describe('BarChart — линия ориентира', () => {
  it('без пропа линии нет', () => {
    expect(render([10, 20, 30])).not.toContain('data-chart-ref-line');
  });

  it('с пропом рисуется линия, названная в <title>, а не поверх столбцов', () => {
    const html = render([10, 20, 30], { value: 20, label: 'ср.' });
    expect(html).toContain('data-chart-ref-line');
    // Имя линии живёт в <title> (читалка + подсказка по наведению). Печатать его НА полотне
    // нельзя: среднее по определению внутри размаха, значит подпись всегда легла бы на столбцы —
    // серый текст поверх заливки серии не читается. Само число хост печатает на лице карточки.
    expect(html).toContain('<title>ср. 20</title>');
    expect(html).not.toMatch(/<text[^>]*>ср\. 20</);
  });

  it('обводка не масштабируется — канон растянутого viewBox', () => {
    const html = render([10, 20, 30], { value: 20, label: 'ср.' });
    const line = html.slice(html.indexOf('data-chart-ref-line'));
    expect(line.slice(0, 400)).toContain('non-scaling-stroke');
  });

  it('уровень выше максимума ряда входит в домен — линия не уезжает за кадр', () => {
    const values = [10, 20, 30];
    // Без ориентира максимум ряда упирается в верх полотна.
    expect(tallestBarTop(render(values))).toBe(0);
    // Тот же ряд с ориентиром вдвое выше максимума: домен растянулся, столбцы стали ниже,
    // а сама линия осталась внутри кадра (без расширения домена её y ушёл бы в минус).
    const html = render(values, { value: 60, label: 'ср.' });
    expect(tallestBarTop(html)).toBeGreaterThan(0);
    expect(refLineY(html)).toBeGreaterThanOrEqual(0);
  });
});
