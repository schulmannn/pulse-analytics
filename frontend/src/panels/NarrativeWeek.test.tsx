import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { WeekCompact, WeekLarge } from '@/panels/NarrativeWeek';
import { buildWeekSummary, type NarrativeInput } from '@/lib/narrative';

/**
 * ТЗ-11 (аудит #554): «Неделя канала» держит ДВА макета, а не один сжатый.
 *
 * L — число со сдвигом, ритм двух недель полоской и одна мысль под ними; M и S — те же величины
 * списком фактов, БЕЗ графика (полоска в 264px вырождается, а проза туда не влезает).
 *
 * Здесь пришпилено то, что отличает макеты друг от друга. Рендер статический
 * (`renderToStaticMarkup`) — идиома остальных тестов компонентов репо; RTL и jsdom ради двух
 * проверок раскладки заводить не за чем.
 */

const day = (i: number) => `2026-06-${String(8 + i).padStart(2, '0')}`;
const mkSeries = (vals: number[]) => vals.map((v, i) => ({ day: day(i), v }));

const input: NarrativeInput = {
  viewsDaily: mkSeries([980, 454, 463, 471, 467, 0, 417, 845, 381, 691, 314, 0, 242, 166]),
  posts: [
    { title: 'Герой процесса', views: 380, reactions: 34, forwards: 4, replies: 0, erv: 10.3 },
    { title: 'Обычный', views: 402, reactions: 11, forwards: 1, replies: 0, erv: 3 },
    { title: 'Ещё один', views: 440, reactions: 10, forwards: 1, replies: 0, erv: 2.5 },
  ],
  avgErv: 5.3,
  subsNow: 4749,
  subsD7: -27,
};

const withIg: NarrativeInput = {
  ...input,
  ig: {
    reachDaily: mkSeries([100, 100, 100, 100, 100, 100, 100, 130, 130, 130, 130, 130, 130, 130]),
    reachWeek: { cur: 910, prev: 700, hasCur: true, hasPrev: true },
    followsDaily: [],
    followersNow: 20_000,
  },
};

const render = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
const bars = (html: string) => [...html.matchAll(/data-bar-tone="([a-z]+)"/g)].map((m) => m[1]);
/** Intl ставит в разрядах неразрывные пробелы — сравниваем по обычным, как и остальные тесты репо. */
const norm = (html: string) => html.replace(/[  ]/g, ' ');

describe('«Неделя канала», макет L', () => {
  const html = render(<WeekLarge summary={buildWeekSummary(withIg)} onPost={() => {}} median={412} />);

  it('полоска несёт две недели тремя голосами: прошлая, эта и пик', () => {
    // День без публикаций столбцом НЕ рисуется (канон BarChart: пустая геометрия — не элемент),
    // поэтому берём ряд без нулей — иначе тест будет стеречь чужое правило, а не своё.
    const dense = render(
      <WeekLarge
        summary={buildWeekSummary({ ...input, viewsDaily: mkSeries([9, 8, 7, 6, 5, 4, 3, 2, 3, 4, 5, 6, 7, 8]) })}
        onPost={() => {}}
        median={null}
      />,
    );
    const tones = bars(dense);
    expect(tones).toHaveLength(14);
    expect(tones.filter((t) => t === 'ghost')).toHaveLength(7);
    expect(tones.filter((t) => t === 'peak')).toHaveLength(1);
  });

  it('число недели и сдвиг стоят наверху, а не внутри предложения', () => {
    expect(norm(html)).toContain('2 639');
    expect(norm(html)).toContain('Прошлая неделя 3 252');
    expect(html).toContain('↓18.8%');
    expect(html).toContain('к прошлой неделе');
  });

  it('слов «выше»/«ниже» рядом со стрелкой нет: направление уже в глифе', () => {
    expect(html).not.toContain('ниже предыдущей');
    expect(html).not.toContain('выше предыдущей');
  });

  it('в леджере нет «Медианного охвата» — медиана уехала в тултип лучшей публикации', () => {
    // Строки леджера с такой подписью больше нет — медиана осталась только в тултипе.
    expect(html).not.toMatch(/>Медианный охват</u);
    expect(html).toContain('title="Медианный охват недели — ');
  });

  it('Instagram — строка леджера, а не абзац рассказа', () => {
    expect(html).toContain('Instagram, та же неделя');
    expect(html).not.toContain('Instagram за ту же неделю: охват');
  });

  it('без Instagram строки нет вовсе', () => {
    const plain = render(<WeekLarge summary={buildWeekSummary(input)} onPost={() => {}} median={null} />);
    expect(plain).not.toContain('Instagram');
  });

  it('числа в мысли без пунктирного подчёркивания', () => {
    expect(html).not.toContain('decoration-dotted');
  });
});

describe('«Неделя канала», макет M и S', () => {
  const html = render(<WeekCompact summary={buildWeekSummary(withIg)} onPost={() => {}} />);

  it('графика нет вовсе: ни полоски, ни искры', () => {
    expect(html).not.toContain('<svg');
    expect(bars(html)).toHaveLength(0);
  });

  it('четыре факта, число первым в строке', () => {
    const items = [...html.matchAll(/<li[^>]*>/g)];
    expect(items).toHaveLength(4);
    expect(html).toContain('просмотров за неделю');
    expect(html).toContain('пик недели');
    expect(html).toContain('подписчиков');
    expect(html).toContain('просмотра у лучшей публикации');
  });

  it('колонка числа фиксированной ширины и одна колонка фактов', () => {
    expect(html).toContain('grid-cols-[96px_1fr]');
    // Две колонки в M были откачены по замеру: 238px на колонку ломают подпись на три строки.
    expect(html).not.toContain('tile-wide:grid-cols-2');
  });

  it('заголовок-вывод собран из той же мысли, что и в L', () => {
    expect(html).toContain('Разницу почти целиком объясняет один день');
  });

  it('сноска с рекордом и Instagram живёт только в широком тайле', () => {
    expect(html).toMatch(/class="hidden shrink-0[^"]*tile-wide:block"/);
    expect(html).toContain('Instagram за ту же неделю');
  });
});
