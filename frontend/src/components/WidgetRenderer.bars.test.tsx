import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WidgetRenderer } from './WidgetRenderer';
import type { WidgetResult } from '@/lib/resolveWidgetMetric';

/**
 * Знакопеременный ряд в столбцах обязан идти в DivergingBars, а не в BarChart: последний
 * масштабируется от нуля вверх (`Math.max(...values, 1)`), и день с оттоком ушёл бы за базовую
 * линию — минус выглядел бы отсутствием данных. Здесь проверяется именно РАЗВИЛКА рендера,
 * доступные имена самих форм покрыты в DivergingBars.test / BarChart-контрактах.
 */
const series = (values: number[]): WidgetResult =>
  ({
    kind: 'series',
    unit: 'number',
    value: '+55',
    valueRaw: 55,
    series: values.map((value, index) => ({ date: `2026-08-0${index + 1}`, value })),
    meta: {},
  }) as unknown as WidgetResult;

describe('WidgetRenderer — выбор столбчатой формы по знаку ряда', () => {
  it('ряд с отрицательными днями рисуется дивергентными столбцами вокруг нуля', () => {
    const html = renderToStaticMarkup(<WidgetRenderer result={series([20, -35, 5])} viz="bar" />);
    // Нулевая ось дивергентной формы: подпись содержит и минимум, и максимум ряда.
    expect(html).toContain('role="img"');
    expect(html).toMatch(/Минимум -35; максимум 20\./);
  });

  it('ряд без отрицательных остаётся обычными столбцами от нуля', () => {
    const html = renderToStaticMarkup(<WidgetRenderer result={series([20, 35, 5])} viz="bar" />);
    expect(html).not.toMatch(/Минимум -/);
  });
});
