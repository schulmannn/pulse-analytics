import { expect, test } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * Виртуализация длинных списков (useVirtualRows): сегмент «Чемпионы» демо-RFM отдаёт 300
 * покупателей (страницы по 200) — DOM обязан держать только окно строк, а прокрутка
 * внутреннего desktop-скроллера [data-dashboard-scroll] дорисовывать хвост списка.
 */
test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'MoySklad analytics is desktop-first');
  await bootDemo(page, '/metrics/ms-rfm?segment=champions', { theme: 'dark' });
});

test('RFM segment customers render a virtual window, not the whole page', async ({ page }) => {
  // Счётчик сегмента — полный (300), список — виртуальный (сильно меньше страницы в 200 строк).
  await expect(page.getByText('300 покупателей')).toBeVisible();
  const list = page.locator('ul[data-virtualized="true"]');
  await expect(list).toHaveCount(1);
  await expect(page.getByText('Покупатель 1', { exact: true })).toBeVisible();
  const windowCount = await list.locator('li').count();
  expect(windowCount).toBeGreaterThan(0);
  expect(windowCount).toBeLessThan(120);

  // Прокрутка ВНУТРЕННЕГО скроллера дорисовывает хвост первой страницы.
  const scroller = page.locator('[data-dashboard-scroll]');
  await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(page.getByText('Покупатель 200', { exact: true })).toBeVisible();
  // Нумерация в виртуальной ветке — по абсолютному индексу, а не позиции в окне.
  const row200 = page.locator('li', { hasText: 'Покупатель 200' });
  await expect(row200.locator('span').first()).toHaveText('200');

  // «Показать ещё» подклеивает вторую страницу; хвост (300) достижим скроллом, DOM всё ещё окно.
  await page.getByRole('button', { name: 'Показать ещё' }).click();
  await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(page.getByText('Покупатель 300', { exact: true })).toBeVisible();
  expect(await list.locator('li').count()).toBeLessThan(120);
});
