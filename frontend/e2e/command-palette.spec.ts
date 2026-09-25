import { test, expect } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * ⌘K-палитра как второй путь к подразделам, которых нет в сайдбаре: «Кампании» (второе
 * представление раздела «Контент») и вкладки /analytics. До этого целая вертикаль кампаний была
 * достижима ровно одним кликом внутри /posts, а вкладки аналитики — только со страницы.
 * Проверяем поиск (частичный ввод) + переход, и что источник при этом не переключается.
 */
async function openPalette(page: import('@playwright/test').Page, query: string) {
  await page.keyboard.press('ControlOrMeta+k');
  const combo = page.getByRole('combobox', { name: 'Поиск' });
  await expect(combo).toBeFocused();
  await combo.fill(query);
  return combo;
}

test('палитра: «камп» находит «Кампании» и открывает список кампаний', async ({ page }) => {
  await bootDemo(page, '/');
  const sourceBefore = await page.evaluate(() => localStorage.getItem('pulse_channel'));
  await openPalette(page, 'камп');
  await page.getByRole('option', { name: 'Кампании', exact: true }).click();
  await expect(page).toHaveURL(/[?&]view=campaigns/);
  await expect(page.getByRole('tab', { name: 'Кампании' })).toHaveAttribute('aria-selected', 'true');
  // Инвариант стабильного источника: переход из палитры по маршруту не пересобирает выбор канала.
  expect(await page.evaluate(() => localStorage.getItem('pulse_channel'))).toBe(sourceBefore);
});

test('палитра: «сравн» находит вкладку аналитики и открывает её', async ({ page }) => {
  await bootDemo(page, '/');
  await openPalette(page, 'сравн');
  await page.getByRole('option', { name: 'Аналитика · Сравнение' }).click();
  await expect(page).toHaveURL(/\/analytics\?tab=compare/);
  await expect(page.getByRole('tab', { name: 'Сравнение' })).toHaveAttribute('aria-selected', 'true');
});
