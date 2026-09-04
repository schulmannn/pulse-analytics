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

/** Самый крупный svg внутри карточки — это её график (иконка виджета всегда 16px). */
async function chartCards(page: Page) {
  return page.evaluate(() => {
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
      rows.push({
        title: section.querySelector('h2, h3')?.textContent?.trim() ?? '?',
        size: section.getAttribute('data-widget-size'),
        card: Math.round(section.getBoundingClientRect().height),
        body: Math.round(body.getBoundingClientRect().height),
        chart: Math.round(chart.h),
      });
    }
    return rows;
  });
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
