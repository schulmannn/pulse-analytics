import { expect, test } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * TG Обзор — карточки «Лучших публикаций» (IG-паритет) + периодная шапка со «Своим периодом»,
 * и инвариант «один датапикер на рабочую страницу». Всё desktop; мобильная ветка не трогается,
 * поэтому спека пропускается на mobile-430 (там прежняя таблица/лента).
 *
 * Демо-канал central → proxy-обложки `/api/tg/mtproto/thumb/:id`; в оффлайне они отдают 404, что
 * проверяет graceful-fallback карточки (обложка → нейтральный плейсхолдер, никогда не битый <img>).
 */
test.describe('TG Обзор — карточки топ-постов + периодная шапка', () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile-430', 'desktop-редизайн: мобильная ветка не менялась');
  });

  test('ровно 3 карточки, без таблицы, обложка падает в плейсхолдер, клик открывает модалку', async ({ page }) => {
    await bootDemo(page, '/');

    const cards = page.getByTestId('tg-top-post-card');
    await expect(cards).toHaveCount(3);
    // Табличный вариант на Обзоре не рендерится видимым (он для Контента/отчётов/PDF).
    await expect(page.getByTestId('tg-top-posts-table')).toBeHidden();

    // Media-failure fallback: proxy-обложки 404 → onError снимает <img>, остаётся плейсхолдер-глиф.
    await expect(cards.locator('img')).toHaveCount(0);
    await expect(cards.first().locator('svg')).toBeVisible();

    const cardBoxes = await Promise.all([0, 1, 2].map((index) => cards.nth(index).boundingBox()));
    expect(cardBoxes.every(Boolean)).toBe(true);
    const boxes = cardBoxes.filter((box): box is NonNullable<typeof box> => box != null);
    expect(Math.max(...boxes.map((box) => box.y)) - Math.min(...boxes.map((box) => box.y))).toBeLessThan(2);
    expect(Math.max(...boxes.map((box) => box.width)) - Math.min(...boxes.map((box) => box.width))).toBeLessThan(2);
    const mediaBox = await cards.first().getByTestId('tg-top-post-media').boundingBox();
    expect(mediaBox).not.toBeNull();
    expect(mediaBox!.width / mediaBox!.height).toBeCloseTo(0.8, 1);

    // Клик по карточке открывает детальную модалку поста.
    await cards.first().click();
    await expect(page.getByRole('dialog', { name: /Детали поста/ })).toBeVisible();
  });

  test('шапка имеет «Свой период»; применение диапазона помечает чип и меняет контент карточек', async ({ page }) => {
    await bootDemo(page, '/');

    const periodGroup = page.getByRole('group', { name: 'Период' });
    await expect(periodGroup).toHaveCount(1);
    await expect(periodGroup.getByRole('button', { name: 'Свой период' })).toBeVisible();
    await expect(page.getByTestId('tg-top-post-card')).toHaveCount(3);

    // Открываем календарь и выбираем окно двумя календарными месяцами ранее — демо-посты укладываются
    // в последние ~23 дня, поэтому это окно гарантированно пустое (детерминированный сдвиг контента).
    await periodGroup.getByRole('button', { name: 'Свой период' }).click();
    // Календарь активности дал демо-фикстурам год дневных точек, поэтому «два месяца назад»
    // больше не пустое окно. Уходим за пределы годового ряда — проверка та же: карточка с
    // разрешимой датой обязана честно сказать «нет данных», а не подставить последние точки.
    for (let back = 0; back < 13; back += 1) {
      await page.getByRole('button', { name: 'Предыдущий месяц' }).click();
    }
    // Derive the dates from the same relative month we navigated to. Absolute May 2026 selectors
    // expired as soon as the real current month moved on, even though the product stayed correct.
    const targetMonth = new Date();
    targetMonth.setDate(1);
    targetMonth.setMonth(targetMonth.getMonth() - 13);
    const targetDate = (day: number) =>
      new Date(targetMonth.getFullYear(), targetMonth.getMonth(), day);
    const dayKey = (day: number) => targetDate(day).toLocaleDateString('ru-RU');
    const rangeStart = page.locator(`button[data-day="${dayKey(5)}"]`);
    const rangeMiddle = page.locator(`button[data-day="${dayKey(10)}"]`);
    const rangeEnd = page.locator(`button[data-day="${dayKey(15)}"]`);
    await rangeStart.click();
    await rangeEnd.click();
    // Standard range geometry: one continuous band, with semantic endpoints instead of three
    // unrelated filled day buttons (the old custom calendar regression).
    await expect(rangeStart).toHaveAttribute('data-range-start', 'true');
    await expect(rangeMiddle).toHaveAttribute('data-range-middle', 'true');
    await expect(rangeEnd).toHaveAttribute('data-range-end', 'true');
    await page.getByRole('button', { name: 'Применить' }).click();

    // Диапазон помечен: пресеты неактивны, а чип несёт сам диапазон в доступном имени (с «–»).
    // Состояние живёт в НАЗВАНИИ, не в aria-pressed: чип — popover-триггер, у него уже есть
    // aria-expanded от Radix, и второе состояние на той же кнопке скринридер читает как конфликт.
    const rangeChip = periodGroup.getByRole('button', { name: /–/ });
    await expect(rangeChip).toBeVisible();
    await expect(periodGroup.getByRole('button', { name: '30д' })).toHaveAttribute('aria-pressed', 'false');

    // Контент реально сузился под окно: за пустой период топа нет → карточки исчезают, честный empty.
    await expect(page.getByTestId('tg-top-post-card')).toHaveCount(0);
    await expect(page.getByText('Недостаточно данных для топа постов.')).toBeVisible();

    // The PagePeriodProvider belongs to the TG feed shell, so the exact custom window survives
    // section navigation instead of resetting to 30d on every tab.
    const rangeLabel = await rangeChip.textContent();
    expect(rangeLabel).toBeTruthy();
    await page.getByRole('link', { name: 'Аналитика', exact: true }).click();
    await expect(page).toHaveURL(/\/analytics/);
    const analyticsPeriod = page.getByRole('group', { name: 'Период' });
    await expect(analyticsPeriod.getByRole('button', { name: rangeLabel! })).toBeVisible();
    // This is a historical window outside the demo graph data. A date-resolvable chart must not
    // fall back to the last archived points: the card stays mounted with an honest empty body.
    const viewsCard = page
      .getByRole('heading', { name: 'Просмотры', exact: true })
      .locator('xpath=ancestor::section[1]');
    await expect(viewsCard.getByText('Нет данных за период')).toBeVisible();
    const historyCard = page
      .getByRole('heading', { name: 'История подписчиков' })
      .locator('xpath=ancestor::section[1]');
    // Subscriber archive is deeper than the post/graph fixture, so it still has rows here. The
    // Calendar-day keys must not shift in UTC-3: the selected 5–15 window ends on the chosen local
    // day, never on the following one. The month is relative so this remains valid year-round.
    const axisDateLabel = (day: number) =>
      targetDate(day)
        .toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
        .replace(/\.$/, '');
    const expectedEndLabel = axisDateLabel(15);
    const shiftedEndLabel = axisDateLabel(16);
    await expect(historyCard.getByText('11 дн. в периоде', { exact: false })).toBeVisible();
    await expect(historyCard.getByText(expectedEndLabel)).toBeVisible();
    await expect(historyCard.getByText(shiftedEndLabel)).toHaveCount(0);
  });

  test('один датапикер на каждой рабочей вкладке: внутри карточек нет собственных период-пилюль', async ({ page }) => {
    await bootDemo(page, '/');

    // Шапка — единственная периодная группа на каждой source/work-вкладке; карточки фида НЕ
    // рендерят локальный селектор. Переходы используют тот же PagePeriodProvider и сохраняют срез.
    const workTabs = [
      { link: 'Обзор', path: /^\/$/ },
      { link: 'Аналитика', path: /\/analytics/ },
      { link: 'Контент', path: /\/posts/ },
      { link: 'Упоминания', path: /\/mentions/ },
    ];

    for (const tab of workTabs) {
      if (tab.link !== 'Обзор') {
        await page.getByRole('link', { name: tab.link, exact: true }).click();
        await expect(page).toHaveURL(tab.path);
      }
      await expect(page.getByRole('group', { name: 'Период', exact: true })).toHaveCount(1);
      await expect(page.getByRole('group', { name: 'Период страницы' })).toHaveCount(0);
      await expect(page.getByRole('toolbar', { name: 'Период виджета' })).toHaveCount(0);
    }
  });

  test('Главная — исключение: виджеты вне фида сохраняют собственные настройки/период', async ({ page }) => {
    await bootDemo(page, '/home');

    // Демо-доска пуста — собираем набор по умолчанию, чтобы получить виджеты с собственным периодом.
    await page.getByRole('button', { name: 'Собрать по умолчанию' }).click();

    // На Главной нет авторитетной «шапочной» периодной группы — доска не управляется одним периодом
    // страницы (в отличие от фида), поэтому каждый виджет держит свой сохранённый период.
    await expect(page.getByRole('group', { name: 'Период', exact: true })).toHaveCount(0);

    // Независимая конфигурация периода живёт в собственном диалоге настроек каждого виджета
    // (⋯ → «Изменить»), а не в общей шапке — открываем его и убеждаемся, что он появляется.
    await page.getByRole('button', { name: /^Меню виджета/ }).first().click();
    const editItem = page.getByRole('menuitem', { name: 'Изменить' });
    await expect(editItem).toBeVisible();
    await editItem.click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });
});
