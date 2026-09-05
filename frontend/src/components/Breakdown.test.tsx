import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Breakdown } from './Breakdown';
import { ExpandedChartHeightContext } from './ExpandableChart';

/**
 * Анатомия строки разбивки: шапка колонок, ранг, ОТДЕЛЬНАЯ колонка доли, футер-ссылка.
 *
 * Рендер статический (react-dom/server), как в ShareRows.test.tsx: окружение юнитов — `node`,
 * @testing-library в зависимостях нет и заводить его ради трёх проверок разметки не за что.
 * Побочный эффект тут полезен: layout-эффекты не выполняются, поэтому замеренная высота шапки
 * заведомо равна её первому-кадровому предположению — бюджет строк проверяется детерминированно.
 */

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
const text = (markup: string) => markup.replace(/<[^>]*>/g, '');

const geo = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    label: `Страна-${i + 1}`,
    value: 100 - i,
    display: String(100 - i),
    share: (100 - i) / 1000,
  }));

/** Сколько подписей реально доехало до разметки — счёт строк без опоры на служебные атрибуты. */
const shownLabels = (markup: string, items: { label: string }[]) =>
  items.filter((item) => markup.includes(`>${item.label}<`)).length;

describe('Breakdown — строка как позиция таблицы', () => {
  it('печатает шапку колонок над списком и ранг у ранжированного списка', () => {
    const markup = html(
      <Breakdown items={geo(3)} columns={{ label: 'Страна', value: 'Подписчики' }} ranked />,
    );

    // Шапка — не строка данных: она обязана нести ИМЕНА колонок, иначе «71» в правой колонке
    // остаётся без единицы измерения (D6/D16 — читатель гадает, это люди или проценты).
    expect(markup).toContain('data-breakdown-header');
    expect(markup).toContain('>Страна<');
    expect(markup).toContain('>Подписчики<');
    expect(markup).toContain('>Доля<');
    // Ранг — своя колонка слева, а не приписка к подписи: «1» и «10» не должны сдвигать подписи.
    expect(markup).toContain('>1<');
    expect(markup).toContain('>3<');
  });

  it('держит долю В СВОЕЙ колонке, а не склейкой со значением', () => {
    const markup = html(<Breakdown items={[{ label: 'Подписчики', value: 71, display: '71', share: 0.71 }]} />);

    // Склейка «71 · 71%» читалась одним числом с непонятным разделителем; теперь значение и доля
    // стоят в РАЗНЫХ ячейках, поэтому разделителя между ними в тексте строки быть не должно.
    expect(markup).toContain('>71%<');
    expect(text(markup)).not.toContain('· 71%');
    // Целая доля — без хвостовой «.0»: колонка печатается через formatShare, а не toFixed(1).
    expect(markup).not.toContain('71.0%');
  });

  it('заменяет «+N ещё» ссылкой на полный список, когда вызывающий её дал', () => {
    const items = geo(12);
    const withMore = html(
      <ExpandedChartHeightContext.Provider value={195}>
        <Breakdown items={items} more={{ label: 'Все 12 стран', to: '/metrics/ig-countries' }} />
      </ExpandedChartHeightContext.Provider>,
    );
    const withoutMore = html(
      <ExpandedChartHeightContext.Provider value={195}>
        <Breakdown items={items} />
      </ExpandedChartHeightContext.Provider>,
    );

    expect(withMore).toContain('href="/metrics/ig-countries"');
    expect(text(withMore)).toContain('Все 12 стран');
    // Без `more` поведение прежнее — иначе правка потребовала бы обойти все вызовы разом.
    expect(withoutMore).not.toContain('<a');
    expect(text(withoutMore)).toContain('ещё — полный список в «Развернуть»');
  });

  it('шапка занимает место в бюджете тайла, но не ценой строки данных', () => {
    const items = geo(8);
    const columns = { label: 'Страна', value: 'Подписчики' };
    // Свободного места ровно столько, что шапка помещается в остаток от последней строки.
    const roomy = html(
      <ExpandedChartHeightContext.Provider value={221}>
        <Breakdown items={items} columns={columns} />
      </ExpandedChartHeightContext.Provider>,
    );
    const roomyBare = html(
      <ExpandedChartHeightContext.Provider value={221}>
        <Breakdown items={items} />
      </ExpandedChartHeightContext.Provider>,
    );
    // Тесный тайл: та же шапка уже вытесняет строку.
    const tight = html(
      <ExpandedChartHeightContext.Provider value={195}>
        <Breakdown items={items} columns={columns} />
      </ExpandedChartHeightContext.Provider>,
    );
    const tightBare = html(
      <ExpandedChartHeightContext.Provider value={195}>
        <Breakdown items={items} />
      </ExpandedChartHeightContext.Provider>,
    );

    // Шапка занимает место ВНУТРИ тела тайла — её высота обязана уходить из бюджета строк, иначе
    // нижняя строка уедет под кромку карточки (N1). Но заголовок — мебель: имя измерения уже
    // стоит в заголовке карточки, поэтому платить за него ДАННЫМИ нельзя.
    expect(roomy).toContain('data-breakdown-header');
    expect(shownLabels(roomy, items)).toBe(shownLabels(roomyBare, items));
    expect(tight).not.toContain('data-breakdown-header');
    expect(shownLabels(tight, items)).toBe(shownLabels(tightBare, items));
  });
});
