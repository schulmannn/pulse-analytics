import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BarChart } from './BarChart';
import { ChartExpandedContext } from './ExpandableChart';

/**
 * ПОДПИСИ-ЗНАЧЕНИЯ над столбцами (только в развороте) имеют СВОЮ плотность, отдельную от
 * плотности оси.
 *
 * Раньше значение печаталось везде, где стоит тик оси, а у канонической оси
 * (`timeAxisFromDayKeys`) массив ПОЛНОЙ длины: «тик» есть у каждого столбца, поэтому подпись
 * получал каждый — за 90-дневное окно вдоль оси выстраивался ряд из 90 чисел. У плотных
 * источников он читался как густая линейка, у разрежённых (Rusender: 12 непустых дней из 90) —
 * как стена нулей. Ось это не задевало: её пустые строки отсеивает `showLabel`, а у значения
 * такого фильтра не было.
 *
 * Правка общая для ВСЕХ источников, поэтому пиннится тестом.
 */

/** Ось канонической формы: массив полной длины, месяц-тики и пустые строки между ними. */
function monthAxis(n: number): string[] {
  return Array.from({ length: n }, (_, i) => (i % 30 === 0 ? 'Jul' : ''));
}

function render(values: number[], axisLabels: string[]) {
  return renderToStaticMarkup(
    <ChartExpandedContext.Provider value={true}>
      <BarChart values={values} labels={values.map((_, i) => `д${i}`)} axisLabels={axisLabels} />
    </ChartExpandedContext.Provider>,
  );
}

/** Подписи-значения рисуются классом fill-ink2 — только они, ось несёт data-chart-axis-label. */
const countValueLabels = (html: string) => (html.match(/fill-ink2/g) ?? []).length;

describe('BarChart — плотность подписей-значений в развороте', () => {
  it('длинное окно не подписывает каждый столбец', () => {
    const n = 90;
    const values = Array.from({ length: n }, (_, i) => (i === 34 ? 90 : i % 7 === 0 ? 5 : 0));
    const html = render(values, monthAxis(n));
    const labels = countValueLabels(html);
    expect(labels).toBeGreaterThan(0);
    // Ключевое: подписей КРАТНО меньше, чем столбцов. До правки их было ровно n.
    expect(labels).toBeLessThan(n / 2);
  });

  it('нулевые столбцы не подписываются — «0» над пустым местом это шум', () => {
    // Все дни нулевые: подписывать нечего вовсе, хотя тик оси формально есть у каждого.
    const n = 60;
    const html = render(Array.from({ length: n }, () => 0), monthAxis(n));
    expect(countValueLabels(html)).toBe(0);
  });

  it('отрицательные значения подписываются — там ноль осмыслен', () => {
    const html = render([-4, 0, 0, 0, 0, 0, 0, 0], Array.from({ length: 8 }, () => 'Пн'));
    expect(countValueLabels(html)).toBeGreaterThan(0);
  });

  it('короткое окно продолжает подписывать свои столбцы', () => {
    // Недельное окно — букв на каждом столбце, места хватает: прежнее поведение сохраняется.
    const values = [3, 5, 2, 8, 1, 4, 6];
    const html = render(values, ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']);
    expect(countValueLabels(html)).toBe(values.length);
  });
});
