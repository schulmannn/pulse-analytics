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
