import { expect, test } from '@playwright/test';
import { bootDemo } from './helpers';

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop segmented controls');
  await bootDemo(page, '/home', { theme: 'dark' });
});

test('full-screen widget editor uses labelled sliding segments for chart settings', async ({ page }) => {
  const buildDefaults = page.getByRole('button', { name: 'Собрать по умолчанию' });
  if (await buildDefaults.isVisible()) await buildDefaults.click();
  await page.getByRole('button', { name: /^Развернуть виджет/ }).first().click();

  const dialog = page.getByRole('dialog', { name: /^Explorer/ });
  await expect(dialog).toBeVisible();

  const period = dialog.getByRole('group', { name: 'Период', exact: true });
  const periodIndicator = period.locator('[data-segmented-indicator]');
  await expect(period).toBeVisible();
  await expect(periodIndicator).toHaveCount(1);
  const before = await periodIndicator.evaluate((node) => getComputedStyle(node).transform);
  await period.getByRole('button', { name: '7д', exact: true }).click();
  await expect(period.getByRole('button', { name: '7д', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => periodIndicator.evaluate((node) => getComputedStyle(node).transform)).not.toBe(before);

  const viz = dialog.getByRole('group', { name: 'Визуализация', exact: true });
  await expect(viz).toBeVisible();
  await viz.getByRole('button', { name: 'Столбцы', exact: true }).click();
  await expect(viz.getByRole('button', { name: 'Столбцы', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await expect(dialog.getByRole('group', { name: 'Грануляция', exact: true })).toBeVisible();
  await expect(dialog.getByRole('group', { name: 'Сравнение', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
