import { isValidElement, type ReactElement, type ReactNode } from 'react';
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
/** Пары «куда ведёт → что подписано»: ссылки стережём по смыслу, а не по классам. */
const links = (html: string) =>
  [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]] as const);

/**
 * КЛЮЧИ строк списка ненаблюдаемы в HTML, а `renderToStaticMarkup` — в отличие от клиентского
 * рендера — о дублях не предупреждает. Зато сам компонент чистая функция без хуков: зовём её
 * напрямую и читаем `key` у элементов дерева. Так дубль ловится ровно там, где живёт.
 */
function liKeys(node: ReactNode, out: (string | null)[] = []): (string | null)[] {
  if (Array.isArray(node)) {
    for (const child of node) liKeys(child, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.type === 'li') out.push(el.key);
  liKeys(el.props.children, out);
  return out;
}
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
    // СМЕНА КОНТРАКТА (N14): было литеральное «просмотра» при любом числе. У этой фикстуры
    // лучшая публикация набрала 440 — по-русски это «440 просмотров». Форма слова теперь
    // считается от числа, поэтому ожидание перевёрнуто вместе с поведением.
    expect(html).toContain('просмотров у лучшей публикации');
    expect(html).not.toContain('просмотра у лучшей публикации');
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

/**
 * R7 (ресёрч Refero) — ФАКТЫ ЛЕДЖЕРА ВЕДУТ НА СВОИ СТРАНИЦЫ, и хвосты аудита N13–N15.
 *
 * Числа в мысли уже были ссылками (`NarrativeSeg 'number'` несёт `to`), а вот леджер и список
 * фактов оставались текстом: «Постов за неделю», «База», «подписчиков» никуда не вели, хотя у
 * каждого из них есть страница метрики с теми же рядами. Здесь пришпилено, КУДА ведёт каждая
 * подпись и что подпись «Лучшая публикация» ссылкой не стала — она открывает карточку поста.
 */
const collide: NarrativeInput = {
  ...input,
  // Пик недели 440 и лучшая публикация 440 печатаются одной строкой «440» — на этой паре
  // ключ, собранный из напечатанного значения, и схлопывался. Сумма недели 741 и база 4 741
  // дают формы «просмотр»/«подписчик»: литеральные окончания на них видно сразу.
  viewsDaily: mkSeries([100, 100, 100, 100, 100, 100, 100, 440, 51, 50, 50, 50, 50, 50]),
  subsNow: 4741,
};

describe('«Неделя канала»: тихие ссылки фактов (R7)', () => {
  const large = render(<WeekLarge summary={buildWeekSummary(withIg)} onPost={() => {}} median={412} />);
  const compact = render(<WeekCompact summary={buildWeekSummary(withIg)} onPost={() => {}} />);

  it('L: подписи леджера ведут на свои страницы метрик', () => {
    expect(links(large)).toEqual(
      expect.arrayContaining([
        ['/posts', 'Постов за неделю'],
        ['/metrics/subscribers', 'База'],
        ['/metrics/ig-reach', 'Instagram, та же неделя'],
      ]),
    );
  });

  it('L: «Лучшая публикация» ссылкой не стала — у неё карточка поста, а не страница', () => {
    expect(links(large).map(([, text]) => text)).not.toContain('Лучшая публикация');
    expect(large).toContain('Лучшая публикация');
  });

  it('M и S: слово-подпись факта ведёт на страницу, число остаётся текстом', () => {
    expect(links(compact)).toEqual(
      expect.arrayContaining([
        ['/metrics/views', 'просмотров за неделю'],
        ['/metrics/views', 'пик недели'],
        ['/metrics/subscribers', 'подписчиков'],
      ]),
    );
    // Значение стоит своей колонкой и ссылкой не становится: «число → куда» читается парой.
    // Сравнивать с готовой строкой числа нельзя — в разрядах у Intl неразрывный пробел, и такое
    // отрицание всегда истинно; поэтому проверяем ФОРМУ: ни одна ссылка не выглядит числом.
    for (const [, text] of links(compact)) {
      expect(text, `ссылкой стало число «${text}»`).not.toMatch(/^[\d\s.]+[kMB]?$/u);
    }
  });

  it('ссылка не красится акцентом: цвет буквы остаётся цветом соседнего текста', () => {
    for (const html of [large, compact]) {
      expect(html).not.toMatch(/<a [^>]*class="[^"]*text-primary/);
    }
  });
});

describe('«Неделя канала»: хвосты аудита N13–N15', () => {
  it('N13: у каждой строки компакта свой ключ, даже когда числа совпали', () => {
    const keys = liKeys(WeekCompact({ summary: buildWeekSummary(collide), onPost: () => {} }));
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
  });

  it('N14: форма существительного считается от числа, а не пишется литералом', () => {
    const html = render(<WeekCompact summary={buildWeekSummary(collide)} onPost={() => {}} />);
    expect(html).toContain('просмотр за неделю');
    expect(html).toContain('просмотров у лучшей публикации');
    // «подписчиков» — префикс «подписчик», поэтому проверяем отрицанием лишнего.
    expect(html).not.toContain('подписчиков');
  });

  it('N14: та же форма и в леджере большого макета', () => {
    const html = render(<WeekLarge summary={buildWeekSummary(collide)} onPost={() => {}} median={null} />);
    expect(html).toContain('просмотров · «Ещё один»');
  });

  it('N15: «Прошлая неделя» не печатается по неполному окну', () => {
    // Десять дней истории: прошлого окна ещё нет, и три его дня не выдаются за неделю.
    const short = buildWeekSummary({ ...input, viewsDaily: mkSeries([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) });
    const html = render(<WeekLarge summary={short} onPost={() => {}} median={null} />);
    expect(html).toContain('без сравнения');
    expect(html).not.toContain('Прошлая неделя');
  });
});
