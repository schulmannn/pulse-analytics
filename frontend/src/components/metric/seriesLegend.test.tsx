import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SeriesLegend } from './seriesLegend';

/**
 * R3 — легенда рейла отвечает «что с чем».
 *
 * Рейл «Сравнение» печатал имя базы и её число; ДАТ обоих окон не было нигде, кроме тултипа
 * графика, — то есть узнать, какая неделя сравнивается с какой, можно было только наведя курсор.
 * Один компонент рисует обе легенды, поэтому маркер рейла обязан совпадать с маркером полотна
 * буквально, а не «по смыслу»: две копии одного штриха уже расходились на других поверхностях.
 */
const PRIMARY = { role: 'primary' as const, label: 'Текущий период', dates: '5 – 11 июн.', value: '12.3k' };
const COMPARISON = { role: 'comparison' as const, label: 'Пред. период', dates: '29 мая – 4 июн.', value: '9.9k' };
const ITEMS = [PRIMARY, COMPARISON];

describe('SeriesLegend, rail-layout', () => {
  it('печатает обе серии с датами окон и итогами', () => {
    const html = renderToStaticMarkup(<SeriesLegend layout="rail" items={ITEMS} />);
    expect(html).toContain('data-series-role="primary"');
    expect(html).toContain('data-series-role="comparison"');
    expect(html).toContain('5 – 11 июн.');
    expect(html).toContain('29 мая – 4 июн.');
    expect(html).toContain('12.3k');
    expect(html).toContain('9.9k');
    // Ровно две строки: третьей серии у сравнения периодов не бывает.
    expect(html.match(/data-series-role=/g)).toHaveLength(2);
  });

  it('маркеры — те же, что рисует легенда полотна (один компонент, а не копия)', () => {
    const rail = renderToStaticMarkup(<SeriesLegend layout="rail" items={ITEMS} />);
    const chart = renderToStaticMarkup(<SeriesLegend layout="chart" items={ITEMS} />);
    const marks = (html: string) =>
      [...html.matchAll(/<span aria-hidden="true" class="([^"]+)" style="([^"]+)"><\/span>/g)].map(
        (m) => `${m[1]}|${m[2]}`,
      );
    expect(marks(rail)).toEqual(marks(chart));
    expect(marks(rail)).toEqual([
      'h-0.5 w-4 rounded-full|background-color:hsl(var(--chart-role-primary))',
      'w-4 border-t-2 border-dashed|border-color:hsl(var(--chart-role-comparison))',
    ]);
  });

  it('столбцовое полотно — свотчи, и альфа призрака приходит от хоста', () => {
    const html = renderToStaticMarkup(
      <SeriesLegend layout="rail" marker="bar" comparisonColor="hsl(var(--chart-role-comparison) / 0.8)" items={ITEMS} />,
    );
    expect(html).toContain('class="h-2 w-3 rounded-sm" style="background-color:hsl(var(--chart-role-primary))"');
    expect(html).toContain('class="h-2 w-3 rounded-sm" style="background-color:hsl(var(--chart-role-comparison) / 0.8)"');
    expect(html).not.toContain('border-dashed');
  });

  it('без второй серии на полотне маркеров нет — штрих обещал бы линию, которой не рисуют', () => {
    const html = renderToStaticMarkup(<SeriesLegend layout="rail" marker="none" items={ITEMS} />);
    expect(html).not.toContain('aria-hidden="true"');
    // Строки при этом остаются полными: подпись, даты и число — та же анатомия, что у всех.
    expect(html).toContain('29 мая – 4 июн.');
    expect(html).toContain('9.9k');
  });

  it('даты и числа — необязательные: полотно печатает только подписи серий', () => {
    const html = renderToStaticMarkup(<SeriesLegend layout="chart" items={ITEMS} />);
    expect(html).not.toContain('29 мая – 4 июн.');
    expect(html).not.toContain('9.9k');
  });
});

describe('SeriesLegend, chart-layout', () => {
  it('чип-переключатель несёт aria-pressed', () => {
    const on = renderToStaticMarkup(
      <SeriesLegend layout="chart" items={ITEMS} onToggleComparison={() => {}} comparisonPressed />,
    );
    const off = renderToStaticMarkup(
      <SeriesLegend layout="chart" items={ITEMS} onToggleComparison={() => {}} comparisonPressed={false} />,
    );
    expect(on).toContain('aria-pressed="true"');
    expect(off).toContain('aria-pressed="false"');
    // Выключенный чип гаснет и зачёркивается — но остаётся кнопкой, а не пропадает.
    expect(off).toContain('opacity-40 line-through');
  });

  it('выключенное страницей сравнение держит место, но ничего не утверждает', () => {
    const html = renderToStaticMarkup(
      <SeriesLegend
        layout="chart"
        items={[PRIMARY, { ...COMPARISON, hidden: true }]}
      />,
    );
    // `invisible`, а не `hidden`: чип уходит из ВИДА, но не из потока — иначе всё, что под
    // графиком, дёргается вверх на высоту строки легенды.
    expect(html).toContain('gap-1.5 invisible" aria-hidden="true"');
    expect(html).not.toContain('gap-1.5" aria-hidden="true"');
  });
});
