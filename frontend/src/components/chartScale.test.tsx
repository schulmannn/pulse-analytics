import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { niceScale } from './LineChart';
import { MultiLineChart } from './MultiLineChart';

/**
 * Две мелочи из аудита #554 про одно и то же: пик серии упирался в самый верх графика.
 *
 *   • `niceScale` отдавала `hi === maxV`, когда максимум кратен шагу, — вершина линии ложилась
 *     РОВНО на верхнюю линейку сетки и сливалась с ней (/metrics/ig-follows);
 *   • `MultiLineChart` строила домен без запаса вовсе — пиковая точка вставала на y=0, на самый
 *     край вьюпорта, где кружок и штрих обрезаются пополам.
 *
 * В обоих случаях глазу нечем отличить «дошло до максимума окна» от «упёрлось в край графика».
 */

describe('niceScale: запас над пиком', () => {
  it('максимум, кратный шагу, не становится потолком', () => {
    const { hi } = niceScale(0, 1000);
    expect(hi).toBeGreaterThan(1000);
  });

  it('запас есть и на мелком домене', () => {
    const { hi } = niceScale(0, 10);
    expect(hi).toBeGreaterThan(10);
  });

  it('круглые — ЛИНЕЙКИ сетки; потолок домена стоит над ними', () => {
    // Раньше здесь проверялось, что кратен шагу сам hi. Это и был источник N9: требование
    // «потолок = линейка» при потолке в 4.5 шага не оставляет места для маленького запаса —
    // ближайшая линейка выше круглого максимума отстоит на ПОЛШАГА. Круглыми обязаны быть
    // линейки (иначе подписи оси дают «4.9k / 4.9k»), а потолок — только выше пика.
    for (const max of [10, 145, 1000, 4950, 120_000]) {
      const { hi, lo, step, ticks } = niceScale(0, max);
      expect(hi).toBeGreaterThan(max);
      for (const t of ticks) expect(Math.abs(t / step - Math.round(t / step))).toBeLessThan(1e-9);
      expect(lo).toBe(0);
    }
  });

  it('делений по-прежнему не больше пяти: запас не плодит линейки сетки', () => {
    for (const max of [10, 145, 1000, 4950, 120_000]) {
      // Считаем ЛИНЕЙКИ, а не (hi−lo)/step: потолок домена теперь стоит НАД последней линейкой,
      // и отношение перестало быть их числом. Смысл проверки прежний — сетка не густеет.
      const { ticks } = niceScale(0, max);
      expect(ticks.length).toBeLessThanOrEqual(5);
    }
  });

  it('запас не выкидывает пик на две трети высоты (N9)', () => {
    // Круглый максимум — самый частый случай у процентов и счётчиков. Раньше запас добавлялся ДО
    // выбора шага, переводил домен в следующую скобку лестницы, и hi прыгал с 100 на 150.
    for (const max of [10, 100, 1000, 10_000]) {
      const { hi } = niceScale(0, max);
      expect(hi).toBeGreaterThan(max);
      expect(hi).toBeLessThanOrEqual(max * 1.12);
    }
  });

  it('заявленный потолок (yMax) — это рамка, а не точка ряда', () => {
    // «Доля топ-N» товаров приходит с yMax=100 и обязана рисоваться ровно до 100 %.
    const { hi, lo, ticks } = niceScale(0, 100, true);
    expect(hi).toBe(100);
    expect(lo).toBe(0);
    expect(ticks[0]).toBe(100);
  });
});

describe('MultiLineChart: пик не сидит на краю', () => {
  const labels = ['1', '2', '3', '4'];
  const series = [{ name: 'A', color: 'var(--chart-1)', values: [10, 40, 100, 70] }];

  it('вершина линии отступает от верхнего края вьюпорта', () => {
    const html = renderToStaticMarkup(
      <MultiLineChart
        labels={labels}
        series={series}
        height={200}
        format={(v) => String(v ?? '—')}
        ariaLabel="Тест"
      />,
    );
    // Все Y-координаты полилиний: минимальная — вершина. На домене без запаса она равна 0.
    const ys = [...html.matchAll(/[\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
    expect(ys.length).toBeGreaterThan(0);
    expect(Math.min(...ys)).toBeGreaterThan(0.5);
  });
});
