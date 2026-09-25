import { expect, test, type Locator, type Page } from '@playwright/test';
import { bootDemo, overflowingCards } from './helpers';

/**
 * ВТОРОЕ ЧИСЛО ГЕРОЯ И ЛИНИЯ СРЕДНЕГО (R8, референс Mercury Insights / Resend Metrics).
 *
 * Итог окна не отвечает, каким был обычный день, — а ответ до сих пор жил только в тултипе
 * графика, то есть был недоступен без мыши. Здесь пришпилено ровно то, что видно глазом:
 *  • у половинной карточки добавка есть, у той же карточки в размере S — нет (гейт по выбору
 *    владельца, а не по догадке о вьюпорте);
 *  • в варианте «Столбцы» среднее становится линией — тем же числом, что напечатано в шапке;
 *  • шапка от добавки не переполняется и график не выдавливается за кромку.
 */

const card = (page: Page, title: string): Locator =>
  page.locator('section[data-widget-size]').filter({
    has: page.getByRole('heading', { name: title, exact: true }),
  });

/** Вторичное число + подпись одной строкой, как их читает человек. */
async function secondary(scope: Locator): Promise<string | null> {
  const slot = scope.locator('[data-chart-card-secondary]');
  return (await slot.count()) === 0 ? null : ((await slot.first().innerText()).replace(/\s+/g, ' ').trim());
}

async function openEditor(page: Page, title: string) {
  await page.getByRole('button', { name: `Меню виджета «${title}»` }).click();
  await page.getByRole('menuitem', { name: 'Изменить' }).click();
  const editor = page.getByRole('dialog', { name: `Настройка виджета «${title}»` });
  await expect(editor).toBeVisible();
  return editor;
}

test.describe('герой: вторая цифра и линия среднего', () => {
  test.beforeEach(async ({ browserName: _b }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'добавка живёт только в широкой карточке');
  });

  test('/: «Просмотры» печатают среднее за день; в размере S — нет', async ({ page }) => {
    await bootDemo(page, '/');
    const views = card(page, 'Просмотры');
    await expect(views).toBeVisible();

    const text = await secondary(views);
    expect(text, 'добавка у половинной карточки').toMatch(/^\S+ в среднем за день$/);
    // Период в добавке не печатается (вето владельца на дубль окна в теле карточки).
    expect(text).not.toMatch(/дн\.|всё время/);

    // Карточка от добавки не поехала: ни одна плитка страницы не получила внутренний скролл.
    expect(await overflowingCards(page)).toEqual([]);

    // S — тот же виджет, тот же период, но добавке в S-шапке места нет.
    const editor = await openEditor(page, 'Просмотры');
    await editor.getByRole('button', { name: 'S', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
    await expect(views).toHaveAttribute('data-widget-size', 'third');
    await expect.poll(async () => secondary(views)).toBeNull();
  });

  test('/: вариант «Столбцы» рисует линию среднего тем же числом', async ({ page }) => {
    await bootDemo(page, '/');
    const views = card(page, 'Просмотры');
    const headline = await secondary(views);
    const number = headline?.replace(' в среднем за день', '') ?? '';
    expect(number.length).toBeGreaterThan(0);

    // В линейном варианте ориентира нет: форму окна там держит сама кривая.
    await expect(views.locator('[data-chart-ref-line]')).toHaveCount(0);

    const editor = await openEditor(page, 'Просмотры');
    await editor.getByRole('button', { name: 'Тип виджета: Столбцы', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);

    const refLine = views.locator('[data-chart-ref-line]');
    await expect(refLine).toHaveCount(1);
    // Имя линии несёт РОВНО то число, что стоит в шапке: две подачи одного среднего не имеют
    // права разойтись по округлению. Имя живёт в <title>, а не текстом на полотне: среднее по
    // определению внутри размаха, и подпись всегда легла бы на столбцы.
    await expect(refLine.locator('title')).toHaveText(`ср. ${number}`);
    await expect(refLine.locator('text')).toHaveCount(0);
    await expect(refLine.locator('line')).toHaveAttribute('vector-effect', 'non-scaling-stroke');
  });

  test('/: в узком слоте добавка уходит — гейт по САМОМУ слоту, не по экрану', async ({ page }) => {
    // Ловушка контейнерных запросов: `tile-wide:` спрятал бы добавку и там, где контейнера `tile`
    // нет вовсе (разворот, страницы метрик) — запрос к отсутствующему контейнеру ложен ВСЕГДА.
    // Поэтому гейт обратный, `tile-narrow:`, и он обязан срабатывать по ширине СЛОТА: на 1280 и
    // 1024 половинная карточка остаётся половинной, а её тайл уже 30rem.
    const seen: Array<{ width: number; tile: number; shown: boolean }> = [];
    for (const width of [1440, 1280, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      await bootDemo(page, '/');
      const views = card(page, 'Просмотры');
      await expect(views).toBeVisible();
      seen.push(
        await views.evaluate((el) => {
          const slot = el.querySelector('.widget-tile-fixed, .widget-tile');
          const sec = el.querySelector('[data-chart-card-secondary]');
          return {
            width: window.innerWidth,
            tile: slot ? Math.round(slot.getBoundingClientRect().width) : 0,
            shown: sec != null && getComputedStyle(sec).display !== 'none',
          };
        }),
      );
    }
    // Сначала — что мерили: тайл обязан реально пересечь порог, иначе проверка пуста.
    expect(seen[0].tile, JSON.stringify(seen)).toBeGreaterThanOrEqual(480);
    expect(seen[1].tile, JSON.stringify(seen)).toBeLessThan(480);
    expect(seen.map((r) => r.shown), JSON.stringify(seen)).toEqual([true, false, false]);
  });

  test('/instagram: «Охват» печатает своё среднее за день', async ({ page }) => {
    await bootDemo(page, '/instagram');
    const reach = card(page, 'Охват');
    await expect(reach).toBeVisible({ timeout: 25_000 });
    await expect.poll(async () => secondary(reach)).toMatch(/^\S+ в среднем за день$/);
    expect(await overflowingCards(page)).toEqual([]);
  });
});
