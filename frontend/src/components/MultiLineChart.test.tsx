import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MultiLineChart } from './MultiLineChart';

/**
 * Компонент вырос из приватного MsMultiLine внутри панели МойСклада и тестов не имел вовсе —
 * его проверяли только e2e того источника. Раз он стал общим, у него появляется свой контракт:
 * серии рисуются, величины форматирует ВЫЗЫВАЮЩИЙ, разрывы честны, а читалка получает имя.
 */
const series = [
  { name: 'Своя доставка', color: 'hsl(var(--chart-1))', values: [10, 20, 30] },
  { name: 'Ozon', color: 'hsl(var(--chart-2))', values: [5, null, 15] },
];
const labels = ['1 июл.', '2 июл.', '3 июл.'];
const rub = (n: number | null | undefined) => (n == null ? '—' : `${n} ₽`);

describe('MultiLineChart', () => {
  it('рисует по линии на серию и подписывает их в легенде', () => {
    const html = renderToStaticMarkup(
      <MultiLineChart series={series} labels={labels} height={200} format={rub} ariaLabel="Выручка по каналам" />,
    );
    expect(html).toContain('Своя доставка');
    expect(html).toContain('Ozon');
    expect(html).toMatch(/aria-label="[^"]*Выручка по каналам[^"]*"/);
  });

  it('величину форматирует вызывающий — график про валюту не знает', () => {
    const html = renderToStaticMarkup(
      <MultiLineChart series={series} labels={labels} height={200} format={rub} ariaLabel="x" />,
    );
    expect(html).toContain('30 ₽');
  });

  it('разрыв в данных рвёт линию, а с bridgeGaps — соединяет', () => {
    // Для счётной величины null значит «измерения нет» и линия обязана рваться. У среднего чека
    // это «в этот день заказов не было» — там разрыв был бы неправдой, и линия соединяется.
    //
    // Считаем не число путей, а ЧТО нарисовано: разорванная серия [5, null, 15] распадается на два
    // ОДИНОЧНЫХ наблюдения, а одиночная точка линией быть не может и рисуется точкой. Соединённая
    // даёт один путь и ни одной сиротской точки. Первая редакция теста этого не знала и требовала
    // от разорванной серии БОЛЬШЕ путей — код был прав, утверждение нет.
    const render = (bridge: boolean) =>
      renderToStaticMarkup(
        <MultiLineChart series={series} labels={labels} height={200} format={rub} ariaLabel="x" bridgeGaps={bridge} />,
      );
    const count = (html: string, tag: string) => (html.match(new RegExp(`<${tag}`, 'g')) ?? []).length;
    const broken = render(false);
    const bridged = render(true);
    expect(count(broken, 'circle')).toBeGreaterThan(count(bridged, 'circle'));
    expect(count(bridged, 'path')).toBeGreaterThan(count(broken, 'path'));
  });

  it('хвост легенды печатается, только когда он задан', () => {
    const withLegend = renderToStaticMarkup(
      <MultiLineChart series={series} labels={labels} height={200} format={rub} ariaLabel="x" legend="и ещё 48 товаров не показаны" />,
    );
    expect(withLegend).toContain('и ещё 48 товаров не показаны');
    const without = renderToStaticMarkup(
      <MultiLineChart series={series} labels={labels} height={200} format={rub} ariaLabel="x" />,
    );
    expect(without).not.toContain('·</span>');
  });
});
