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

test('overview period is shared by every widget and either control updates the page', async ({ page }) => {
  // Reproduce the production bug: old per-card settings disagreed with the 30д page header.
  await page.addInitScript(() => {
    localStorage.setItem(
      'pulse_widget_prefs',
      JSON.stringify({
        'overview-hero': { period: 7 },
        'overview-growth': { period: 90 },
        'overview-top-posts': { period: 7 },
      }),
    );
  });
  await bootDemo(page, '/');

  const pagePeriod = page.getByRole('group', { name: 'Период', exact: true });
  const widgetPeriods = page.getByRole('group', { name: 'Период страницы' });
  await expect(widgetPeriods).toHaveCount(3);

  // The page default wins over every stale saved widget override.
  await expect(pagePeriod.getByRole('button', { name: '30д' })).toHaveAttribute('aria-pressed', 'true');
  for (const group of await widgetPeriods.all()) {
    await expect(group.getByRole('button', { name: '30д' })).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(page.getByText('Просмотры · 30 дн.')).toBeVisible();

  // A card-level pill is now another handle for the same page period, not a private override.
  await widgetPeriods.first().getByRole('button', { name: '7д' }).click();
  await expect(pagePeriod.getByRole('button', { name: '7д' })).toHaveAttribute('aria-pressed', 'true');
  for (const group of await widgetPeriods.all()) {
    await expect(group.getByRole('button', { name: '7д' })).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(page.getByText('Просмотры · 7 дн.')).toBeVisible();
});
