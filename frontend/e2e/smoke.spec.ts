import { test, expect } from '@playwright/test';
import { bootDemo } from './helpers';

test('dashboard boots and navigates from overview to analytics', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await bootDemo(page, '/');
  await expect(page.locator('main')).toBeVisible();

  const analyticsLink = page.locator('a[href="/analytics"]:visible').first();
  await expect(analyticsLink).toBeVisible();
  await analyticsLink.click();

  await expect(page).toHaveURL(/\/analytics$/);
  await expect(page.locator('main section').first()).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('metric drill opens and browser Back returns to the dashboard', async ({ page }) => {
  await bootDemo(page, '/');

  const drill = page.getByRole('button', { name: /^Разбор:/ }).first();
  await expect(drill).toBeVisible();
  await drill.click();
  await expect(page).toHaveURL(/\/metrics\//);
  await expect(page.locator('main')).toBeVisible();

  await page.goBack();
  await expect(page).not.toHaveURL(/\/metrics\//);
  await expect(page.locator('main')).toBeVisible();
});
