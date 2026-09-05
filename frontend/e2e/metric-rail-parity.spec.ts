import { expect, test, type Page } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * D12 (аудит #554) — РЕЙЛ «СРАВНЕНИЕ» ОДИН НА ВСЕ ВЕРТИКАЛИ.
 *
 * Одна сущность жила в двух макетах: у TG рейл был карточкой (`variant="card"` — рамка, фон
 * карточки, тень) с крупным `KpiValue` под подписью, у IG — плоской секцией с числом `text-base`
 * в одну строку с подписью. Метрика, Rusender и упоминания всегда рисовали рейл плоским, то есть
 * карточная подача была единственной копией.
 *
 * Здесь пришпилен РЕНДЕР, а не разметка: у рейлов обеих страниц одинаковая рамка, фон и внутренний
 * отступ, а итог окна набран одним рецептом крупного числа (`[data-kpi-value]`) одного кегля.
 */

type RailShape = {
  border: string;
  background: string;
  padding: string;
  totalFontSize: string | null;
};

async function railShape(page: Page): Promise<RailShape | null> {
  return page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>('[data-rail-card="comparison"]');
    if (!rail) return null;
    const cs = getComputedStyle(rail);
    const total = rail.querySelector<HTMLElement>('[data-kpi-value]');
    return {
      border: `${cs.borderTopWidth} ${cs.borderTopStyle}`,
      background: cs.backgroundColor,
      padding: cs.paddingTop,
      totalFontSize: total ? getComputedStyle(total).fontSize : null,
    };
  });
}

test.describe('рейл «Сравнение»: одна анатомия у TG и IG', () => {
  test.beforeEach(async ({ browserName: _b }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Рейл разбора — desktop-раскладка');
  });

  test('рамка, фон и отступ рейла совпадают', async ({ page }) => {
    await bootDemo(page, '/metrics/views');
    const tg = await railShape(page);
    await bootDemo(page, '/metrics/ig-reach');
    const ig = await railShape(page);

    // Сначала — что мерили: без рейлов проверка прошла бы вхолостую.
    expect(tg, 'рейл TG должен найтись').not.toBeNull();
    expect(ig, 'рейл IG должен найтись').not.toBeNull();

    expect(
      { border: ig?.border, background: ig?.background, padding: ig?.padding },
      `TG ${JSON.stringify(tg)} против IG ${JSON.stringify(ig)}`,
    ).toEqual({ border: tg?.border, background: tg?.background, padding: tg?.padding });
  });

  test('итог окна набран одним рецептом и одним кеглем', async ({ page }) => {
    await bootDemo(page, '/metrics/views');
    const tg = await railShape(page);
    await bootDemo(page, '/metrics/ig-reach');
    const ig = await railShape(page);

    // Крупное число рейла идёт через KpiValue на ОБЕИХ страницах: раньше IG набирал его классами
    // на месте (`text-base`), то есть держал пятую копию рецепта.
    expect(tg?.totalFontSize, `итог окна TG: ${JSON.stringify(tg)}`).not.toBeNull();
    expect(ig?.totalFontSize, `итог окна IG: ${JSON.stringify(ig)}`).not.toBeNull();
    expect(ig?.totalFontSize).toBe(tg?.totalFontSize);
  });
});

/**
 * R3 — РЕЙЛ НАЗЫВАЕТ ДАТЫ ОБОИХ ОКОН И ТЕ ЖЕ МАРКЕРЫ, ЧТО ПОЛОТНО.
 *
 * Рейл печатал имя базы и её число («Пред. период — 9.9k»): даты окон не стояли нигде, кроме
 * тултипа графика, — то есть узнать, какая неделя сравнивается с какой, можно было ТОЛЬКО наведя
 * курсор на точку. Маркеры сверяются по классам, а не «на глаз»: рейл и легенда полотна обязаны
 * рисовать один и тот же штрих, потому что это один компонент, — разойдясь, они соврут молча.
 */
// «5 июн. – 11 июн.» / «29 мая – 4 июн.»: сокращение месяца в ru-RU идёт с точкой, у мая её нет.
const RANGE = /\d{1,2}\s[а-я]+\.?\s–\s\d{1,2}\s[а-я]+\.?/;

test.describe('рейл «Сравнение»: обе серии с датами окон', () => {
  test.beforeEach(async ({ browserName: _b }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Рейл разбора — desktop-раскладка');
  });

  for (const route of ['/metrics/views', '/metrics/ig-reach']) {
    test(`${route}: две строки легенды с датами, маркеры совпадают с полотном`, async ({ page }) => {
      await bootDemo(page, route);
      const rail = page.locator('[data-rail-card="comparison"]');
      await expect(rail).toBeVisible();

      const rows = rail.locator('[data-series-role]');
      await expect(rows).toHaveCount(2);
      await expect(rail.locator('[data-series-role="primary"] [data-series-dates]')).toHaveText(RANGE);
      await expect(rail.locator('[data-series-role="comparison"] [data-series-dates]')).toHaveText(RANGE);
      // Окна разные — иначе подпись «сравнения» указывала бы на само себя.
      const railDates = await rail.locator('[data-series-dates]').allInnerTexts();
      expect(railDates[0]).not.toBe(railDates[1]);

      // Маркер сравнения на странице — ОДИН рецепт: пунктир в легенде полотна и пунктир в рейле.
      // Ровно два вхождения: если бы рейл рисовал свою копию классов, они бы разошлись молча.
      const marks = page.locator('span[aria-hidden="true"][class*="border-dashed"]');
      await expect(marks).toHaveCount(2);
      const classes = await marks.evaluateAll((nodes) => nodes.map((n) => n.className));
      expect(classes[0], `легенда полотна против рейла: ${JSON.stringify(classes)}`).toBe(classes[1]);
      await expect(rail.locator('[data-series-role="comparison"] span[class*="border-dashed"]')).toHaveCount(1);
    });
  }

  test('с выключенной базой легенды нет — на её месте подсказка', async ({ page }) => {
    await bootDemo(page, '/metrics/views?cmp=off');
    const rail = page.locator('[data-rail-card="comparison"]');
    await expect(rail).toBeVisible();
    await expect(rail.locator('[data-series-role]')).toHaveCount(0);
    await expect(rail.getByText('Выберите базу')).toBeVisible();
  });
});

