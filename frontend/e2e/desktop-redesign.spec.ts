import { test, expect } from '@playwright/test';
import { bootDemo } from './helpers';

test('desktop analytics keeps source and summary hierarchy explicit', async ({ page }, testInfo) => {
  await bootDemo(page, '/analytics', { theme: 'dark' });

  const feed = page.locator('[data-feed-block="analytics"]');
  await expect(feed.locator('[data-source-identity]')).toContainText('Telegram · @demo_channel');
  await expect(feed.getByRole('heading', { name: 'Сводка показателей' })).toHaveCount(1);
  await expect(feed.getByText('Ср. просмотры', { exact: true })).toBeVisible();
  await expect(feed.getByText('Публикации', { exact: true })).toBeVisible();
  await expect(feed.getByText('Уведомления вкл.', { exact: true })).toHaveCount(0);

  const dynamicsShot = testInfo.outputPath('analytics-dynamics-dark.png');
  await page.screenshot({ path: dynamicsShot, fullPage: true });
  await testInfo.attach('analytics-dynamics-dark', { path: dynamicsShot, contentType: 'image/png' });

  await feed.getByRole('tab', { name: 'Форматы' }).click();
  await expect(feed.getByRole('tab', { name: 'Форматы' })).toHaveAttribute('aria-selected', 'true');
  await expect(feed.getByRole('heading', { name: 'Сводка показателей' })).toHaveCount(0);

  const analyticsShot = testInfo.outputPath('analytics-formats-dark.png');
  await page.screenshot({ path: analyticsShot, fullPage: true });
  await testInfo.attach('analytics-formats-dark', { path: analyticsShot, contentType: 'image/png' });
});

test('desktop Overview keeps period context compact', async ({ page }, testInfo) => {
  await bootDemo(page, '/', { theme: 'dark' });

  await expect(page.locator('[data-source-identity]')).toContainText('Telegram · @demo_channel');
  await expect(page.getByRole('heading', { name: 'Контекст периода' })).toBeVisible();

  const overviewShot = testInfo.outputPath('overview-dark.png');
  await page.screenshot({ path: overviewShot, fullPage: true });
  await testInfo.attach('overview-dark', { path: overviewShot, contentType: 'image/png' });
});

test('desktop Home labels every mixed-source widget', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('pulse_home_blocks', JSON.stringify({ keys: ['kpi', 'ig-reach'] }));
  });
  await bootDemo(page, '/home', { theme: 'dark' });

  const identities = page.locator('[data-source-identity]');
  await expect(identities).toHaveCount(2);
  await expect(identities.filter({ hasText: 'Telegram · @demo_channel' })).toHaveCount(1);
  await expect(identities.filter({ hasText: 'Instagram · @demo_channel' })).toHaveCount(1);

  const homeShot = testInfo.outputPath('home-sources-dark.png');
  await page.screenshot({ path: homeShot, fullPage: true });
  await testInfo.attach('home-sources-dark', { path: homeShot, contentType: 'image/png' });
});
