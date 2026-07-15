import { test, expect } from '@playwright/test';
import { bootDemo, overflowingCards } from './helpers';

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
  await expect(page.getByRole('heading', { name: 'Главное изменение' })).toBeVisible();

  await page.getByRole('button', { name: 'Меню виджета «Просмотры»' }).click();
  await page.getByRole('menuitem', { name: 'Изменить' }).click();
  const editor = page.getByRole('dialog', { name: 'Настройка виджета «Просмотры»' });
  await expect(editor.getByRole('button', { name: 'S', exact: true })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'M', exact: true })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'L', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await overflowingCards(page)).toEqual([]);

  const overviewShot = testInfo.outputPath('overview-dark.png');
  await page.screenshot({ path: overviewShot, fullPage: true });
  await testInfo.attach('overview-dark', { path: overviewShot, contentType: 'image/png' });
});

test('desktop Instagram Overview keeps the split KPI hierarchy intact', async ({ page }, testInfo) => {
  await bootDemo(page, '/instagram', { theme: 'dark' });

  await expect(page.locator('[data-source-identity]')).toContainText('Instagram · @demo_channel');
  for (const heading of ['Охват', 'Динамика аудитории', 'Просмотры', 'Взаимодействия', 'Вовлечённость']) {
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('heading', { name: 'Неделя аккаунта' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Главное изменение' })).toBeVisible();
  expect(await overflowingCards(page)).toEqual([]);

  const overviewShot = testInfo.outputPath('instagram-overview-dark.png');
  await page.screenshot({ path: overviewShot, fullPage: true });
  await testInfo.attach('instagram-overview-dark', { path: overviewShot, contentType: 'image/png' });
});

test('desktop Home labels every mixed-source widget', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('pulse_home_blocks', JSON.stringify({ keys: ['kpi', 'ig-kpi'] }));
  });
  await bootDemo(page, '/home', { theme: 'dark' });

  const identities = page.locator('[data-source-identity]');
  await expect(identities).toHaveCount(2);
  await expect(identities.filter({ hasText: 'Telegram · @demo_channel' })).toHaveCount(1);
  await expect(identities.filter({ hasText: 'Instagram · @demo_channel' })).toHaveCount(1);
  // Existing personal layouts keep their legacy aggregate instead of being silently migrated.
  await expect(page.getByRole('heading', { name: 'Показатели', exact: true })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'IG · Показатели', exact: true })).toHaveCount(1);

  const homeShot = testInfo.outputPath('home-sources-dark.png');
  await page.screenshot({ path: homeShot, fullPage: true });
  await testInfo.attach('home-sources-dark', { path: homeShot, contentType: 'image/png' });
});
