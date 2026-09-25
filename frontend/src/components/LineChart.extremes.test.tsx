import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LineChart } from './LineChart';

/**
 * D3 (аудит #554): подписи максимума и последней точки слипались.
 *
 * Обе клампились к ОДНОМУ правому краю и ставились по одному правилу «выше точки», поэтому когда
 * максимум приходится на хвост ряда, «10.1k» и «9.9k» рисовались в одной точке и читались кашей.
 * Любые два близких хвоста давали то же самое.
 */
const extremeLabels = (html: string) =>
  [...html.matchAll(/<text[^>]*data-chart-extreme[^>]*>([^<]*)<\/text>/g)].map((m) => ({
    y: Number(m[0].match(/y="([\d.]+)"/)?.[1]),
    x: Number(m[0].match(/x="([\d.]+)"/)?.[1]),
    text: m[1],
  }));

describe('LineChart: конечные подписи не слипаются', () => {
  it('максимум на хвосте разводится с последней точкой по вертикали', () => {
    // Длинный ряд: соседние точки стоят в ~10px друг от друга, поэтому подписи максимума
    // (предпоследняя точка) и последней перекрываются по x — ровно случай с /metrics/views.
    const values = Array.from({ length: 60 }, (_, i) => 5000 + i * 80);
    values[58] = 10100;
    values[59] = 9900;
    const html = renderToStaticMarkup(
      <LineChart values={values} labels={values.map((_, i) => String(i + 1))} markExtremes />,
    );
    const labels = extremeLabels(html);
    expect(labels.length).toBe(2);
    const [a, b] = labels;
    // Разведены минимум на высоту строки — ни одна пара не остаётся в одной точке.
    expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(12);
    // Большее значение выше: порядок читается без легенды.
    const upper = a.y < b.y ? a : b;
    expect(upper.text).toBe('10.1k');
  });

  it('совпавшие максимум и последняя точка печатаются одной подписью', () => {
    const html = renderToStaticMarkup(
      <LineChart values={[1, 2, 3, 10]} labels={['1', '2', '3', '4']} markExtremes />,
    );
    expect(extremeLabels(html).length).toBe(1);
  });

  it('далеко разнесённые экстремумы не двигаются', () => {
    // Максимум в начале ряда — по x они не пересекаются, разводить нечего.
    const html = renderToStaticMarkup(
      <LineChart values={[10000, 900, 800, 700, 600, 500, 400, 300]} labels={['1','2','3','4','5','6','7','8']} markExtremes />,
    );
    const labels = extremeLabels(html);
    expect(labels.length).toBe(2);
    expect(Math.abs(labels[0].x - labels[1].x)).toBeGreaterThan(50);
  });
});
