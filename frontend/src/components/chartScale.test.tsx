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

  it('потолок остаётся круглым числом, кратным шагу', () => {
    for (const max of [10, 145, 1000, 4950, 120_000]) {
      const { hi, lo, step } = niceScale(0, max);
      expect(hi).toBeGreaterThan(max);
      expect(Math.abs(hi / step - Math.round(hi / step))).toBeLessThan(1e-9);
      expect(lo).toBe(0);
    }
  });

  it('делений по-прежнему не больше пяти: запас не плодит линейки сетки', () => {
    for (const max of [10, 145, 1000, 4950, 120_000]) {
      const { hi, lo, step } = niceScale(0, max);
      expect((hi - lo) / step).toBeLessThanOrEqual(4.5);
    }
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
