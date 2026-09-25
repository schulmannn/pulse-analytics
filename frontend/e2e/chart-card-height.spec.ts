import { expect, test, type Page } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * ГРАФИК ПОЛУЧАЕТ ВЫСОТУ СВОЕЙ КАРТОЧКИ (аудит #554, D15).
 *
 * `SIZE_HEIGHT.full` пуста намеренно — полноширинная карточка с леджером или таблицей растёт по
 * содержимому. Но тело карточки это `flex-1 min-h-0` в КОЛОНКЕ БЕЗ ВЫСОТЫ, а такой элемент по
 * спеке флекса получает базис 0 и схлопывается. График внутри меряет хост, видит крошки и падает
 * в свой минимум: «Упоминания по дням» отдавали графику 60px из карточки в 164px, тогда как любая
 * фикс-карточка рядом отдаёт 161–181px. Столбцы читались гребёнкой у нижнего края.
 *
 * Инвариант общий, а не про одну карточку: если тело карточки — график, график занимает бо́льшую
 * часть тела, а не его пол.
 */

/**
 * Карточки, ЧЬЁ ТЕЛО — ГРАФИК. Инвариант выше — про них, и «нашёлся svg» их не описывает: полоска
 * ритма внутри прозы («Неделя канала») тоже svg, но тело там ТЕКСТ, а полоска ему подпорка.
 * Требовать от такой карточки 264px значит требовать пустоты под текстом.
 *
 * Разделяет ПРОЗА РЯДОМ С ГРАФИКОМ — текст тела за вычетом подписей внутри самого svg. Замер на
 * трёх маршрутах демо: у настоящих карточек-графиков это 7–65 символов (число, дельта, подпись),
 * у «Недели канала» — 276. Порог 120 стоит посередине четырёхкратного разрыва, а не впритык.
 */
const PROSE_BESIDE_CHART_MAX = 120;

async function chartCards(page: Page) {
  // Константа живёт в Node, а обход — в браузере: передаём аргументом, иначе её там нет.
  return page.evaluate((maxProse) => {
    const rows: { title: string; size: string | null; card: number; body: number; chart: number }[] = [];
    for (const section of document.querySelectorAll<HTMLElement>('section[data-widget-size]')) {
      const svgs = [...section.querySelectorAll('svg')]
        .map((el) => ({ el, h: el.getBoundingClientRect().height }))
        .sort((a, b) => b.h - a.h);
      const chart = svgs[0];
      // Иконка шапки и пустые состояния — не графики.
      if (!chart || chart.h < 40) continue;
      const body = chart.el.closest<HTMLElement>('.widget-tile, .widget-tile-fixed');
      if (!body) continue;
      // Подписи осей — часть графика, поэтому считаем текст тела БЕЗ svg.
      const withoutCharts = body.cloneNode(true) as HTMLElement;
      for (const svg of withoutCharts.querySelectorAll('svg')) svg.remove();
      const prose = (withoutCharts.textContent ?? '').replace(/\s+/g, ' ').trim().length;
      if (prose > maxProse) continue;
      rows.push({
        title: section.querySelector('h2, h3')?.textContent?.trim() ?? '?',
        size: section.getAttribute('data-widget-size'),
        card: Math.round(section.getBoundingClientRect().height),
        body: Math.round(body.getBoundingClientRect().height),
        chart: Math.round(chart.h),
      });
    }
    return rows;
  }, PROSE_BESIDE_CHART_MAX);
}

/**
 * Снимаем высоты, КОГДА ОНИ УСТОЯЛИСЬ: графики едут через ResizeObserver, и под нагрузкой
 * фиксированного settle в bootDemo не хватает — замер ловил страницу без единого графика.
 */
async function settledCards(page: Page) {
  await expect
    .poll(async () => (await chartCards(page)).length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  let prev = '';
  let cards = await chartCards(page);
  for (let i = 0; i < 40; i++) {
    const sig = JSON.stringify(cards);
    if (sig === prev && cards.length > 0) return cards;
    prev = sig;
    await page.waitForTimeout(250);
    cards = await chartCards(page);
  }
  return cards;
}

test.describe('высота графика в карточке', () => {
  test.beforeEach(async ({ browserName: _b }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Высоты тайлов — desktop-раскладка');
  });

  for (const route of ['/', '/analytics', '/mentions'] as const) {
    test(`${route}: график занимает своё тело, а не его пол`, async ({ page }) => {
      await bootDemo(page, route);
      const cards = await settledCards(page);
      // Сначала — что мерили: пустой обход прошёл бы «зелёным» ни на чём.
      expect(cards.length, `карточки с графиками должны найтись на ${route}`).toBeGreaterThan(0);

      for (const card of cards) {
        // Карточка с графиком не мельче стандартного тайла. Схлопнувшаяся full-карточка была
        // 164px — НИЖЕ треть-карточки рядом, будучи втрое шире её.
        expect(card.card, `высота карточки «${card.title}» (${JSON.stringify(card)})`).toBeGreaterThanOrEqual(264);
        // И сам график не сидит на своём полу (60px): именно туда его и опускала схлопнувшаяся колонка.
        expect(card.chart, `график «${card.title}» (${JSON.stringify(card)})`).toBeGreaterThan(64);
      }
    });
  }

  test('полноширинный дневной ряд выше треть-карточки, но не на весь экран', async ({ page }) => {
    await bootDemo(page, '/mentions');
    const timeline = (await settledCards(page)).find((c) => c.title.startsWith('Упоминания по дням'));
    expect(timeline, 'карточка «Упоминания по дням» должна найтись').toBeTruthy();
    // Больше фикс-тайла 264px и меньше половины окна: таблица под ней остаётся достижимой.
    expect(timeline?.card).toBeGreaterThan(264);
    expect(timeline?.card).toBeLessThan(420);
  });
});
