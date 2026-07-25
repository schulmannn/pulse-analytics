import { expect, test } from '@playwright/test';
import { bootDemo } from './helpers';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Шаг между двумя ячейками в днях. Через round — чтобы перевод часов не сломал арифметику. */
const stepDays = (from: number, to: number) => Math.round((to - from) / DAY_MS);

/**
 * Календарь «Своего периода» как WAI-ARIA date grid: одна точка входа вместо 31 tab-stop'а,
 * двумерная навигация стрелками, разделение каретки и выбора. Всё desktop — мобильная ветка
 * датапикера не менялась.
 */
test.describe('DateRangePicker — клавиатура', () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile-430', 'desktop: мобильный датапикер не менялся');
  });

  /** Открывает попап и уводит календарь в ПРОШЛЫЙ месяц: там нет будущих дней, поэтому каретка
      ходит без упора в конец месяца и проверки не зависят от того, какое сегодня число. */
  const openPastMonth = async (page: import('@playwright/test').Page) => {
    await bootDemo(page, '/');
    await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: 'Свой период' }).click();
    await expect(page.getByRole('grid')).toBeVisible();
    await page.getByRole('button', { name: 'Предыдущий месяц' }).click();
  };

  const focusedDay = (page: import('@playwright/test').Page) => page.locator('[data-day][tabindex="0"]');

  test('вход в сетку стоит одного Tab, и один Tab из неё выводит', async ({ page }) => {
    await openPastMonth(page);

    // Ровно одна ячейка месяца фокусируема — это и есть roving tabindex.
    await expect(focusedDay(page)).toHaveCount(1);
    await expect(page.locator('[data-day][tabindex="-1"]').first()).toBeAttached();

    // Якорь — «Следующий месяц»: последний фокусируемый контрол ПЕРЕД сеткой. В прошлом месяце он
    // активен (в текущем был бы disabled и выпал бы из обхода, сместив счёт нажатий).
    await page.getByRole('button', { name: 'Следующий месяц' }).focus();
    await page.keyboard.press('Tab');
    // Один Tab — и фокус уже внутри сетки (раньше сюда вело до 31 нажатия).
    await expect(page.locator('[data-day]:focus')).toHaveCount(1);

    await page.keyboard.press('Tab');
    // И один Tab выводит из месяца целиком, а не переставляет на соседний день.
    await expect(page.locator('[data-day]:focus')).toHaveCount(0);
  });

  test('стрелки ходят по сетке двумерно: день, неделя, края недели', async ({ page }) => {
    await openPastMonth(page);
    // Якорь — «Следующий месяц»: последний фокусируемый контрол ПЕРЕД сеткой. В прошлом месяце он
    // активен (в текущем был бы disabled и выпал бы из обхода, сместив счёт нажатий).
    await page.getByRole('button', { name: 'Следующий месяц' }).focus();
    await page.keyboard.press('Tab');

    const readFocus = async () => Number(await focusedDay(page).getAttribute('data-day'));
    const start = await readFocus();

    await page.keyboard.press('ArrowRight');
    expect(stepDays(start, await readFocus())).toBe(1);

    // ↑/↓ — это НЕ «соседний элемент списка», а тот же день недели неделей раньше/позже.
    await page.keyboard.press('ArrowDown');
    expect(stepDays(start, await readFocus())).toBe(8);
    await page.keyboard.press('ArrowUp');
    expect(stepDays(start, await readFocus())).toBe(1);

    // Home — понедельник этой недели (сетка Monday-first).
    await page.keyboard.press('Home');
    const monday = await readFocus();
    expect(await page.evaluate((ts) => new Date(ts).getDay(), monday)).toBe(1);

    // End — воскресенье той же недели, ровно через 6 дней.
    await page.keyboard.press('End');
    expect(stepDays(monday, await readFocus())).toBe(6);
  });

  test('каретка отделена от выбора: стрелки не выбирают, Enter выбирает', async ({ page }) => {
    await openPastMonth(page);
    // Якорь — «Следующий месяц»: последний фокусируемый контрол ПЕРЕД сеткой. В прошлом месяце он
    // активен (в текущем был бы disabled и выпал бы из обхода, сместив счёт нажатий).
    await page.getByRole('button', { name: 'Следующий месяц' }).focus();
    await page.keyboard.press('Tab');

    const status = page.getByRole('status');
    // Прогулка стрелками ничего не фиксирует — состояние выбора не двинулось.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await expect(status).toHaveText(/Период не выбран/);
    await expect(page.getByRole('button', { name: 'Применить' })).toBeDisabled();

    // Enter фиксирует первый конец — и это ОБЪЯВЛЯЕТСЯ, а не только подсвечивается.
    await page.keyboard.press('Enter');
    await expect(status).toHaveText(/^Начало: .+\. Выберите конец периода\.$/);
    await expect(page.getByRole('button', { name: 'Применить' })).toBeDisabled();

    // Второй конец — через три дня вправо.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(status).toHaveText(/^Период выбран: с .+ по .+\.$/);

    const apply = page.getByRole('button', { name: 'Применить' });
    await expect(apply).toBeEnabled();
    await apply.click();

    // Диапазон доехал до шапки: чип несёт его в доступном имени.
    await expect(page.getByRole('group', { name: 'Период' }).getByRole('button', { name: /–/ })).toBeVisible();
  });

  test('будущие дни достижимы стрелками и объявлены недоступными, а не выпилены из обхода', async ({ page }) => {
    await bootDemo(page, '/');
    await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: 'Свой период' }).click();
    await expect(page.getByRole('grid')).toBeVisible();

    // Текущий месяц: «Следующий месяц» упирается в потолок — будущих данных не существует.
    await expect(page.getByRole('button', { name: 'Следующий месяц' })).toBeDisabled();

    const future = page.locator('[data-day][aria-disabled="true"]');
    const futureCount = await future.count();
    test.skip(futureCount === 0, 'последний день месяца — будущих ячеек нет');

    // Для ассистивных технологий и тулинга ячейка отключена…
    await expect(future.first()).toBeDisabled();
    await expect(future.first()).toHaveAttribute('aria-label', /, недоступно$/);

    // …но НЕ нативным `disabled`, иначе она невыбираема, и каретка упирается в молчаливую дыру
    // в конце месяца вместо внятного «недоступно». Проверяем, что фокус на неё реально встаёт.
    await expect(future.first()).not.toHaveAttribute('disabled', /.*/);
    await future.first().focus();
    await expect(future.first()).toBeFocused();

    // Клик ничего не выбирает — гейт живёт в обработчике, а не в pointer-events. Шлём событие
    // напрямую: обычный click Playwright не выполнит, он уважает aria-disabled (что само по себе
    // подтверждает разметку).
    await future.first().dispatchEvent('click');
    await expect(page.getByRole('status')).toHaveText(/Период не выбран/);
  });
});
