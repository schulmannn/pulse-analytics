import { expect, test } from '@playwright/test';
import { bootDemo, overflowingCards } from './helpers';

test.beforeEach(async (_fixtures, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'MoySklad analytics is desktop-first');
});

test('production-shaped compact lists fit fixed cards', async ({ page }, testInfo) => {
  await bootDemo(page, '/sklad', { theme: 'dark', msMax: true });

  const funnel = page.getByRole('heading', { name: 'Статусы заказов' }).locator('xpath=ancestor::section[1]');
  const products = page.getByRole('heading', { name: 'Товары', exact: true }).locator('xpath=ancestor::section[1]');
  await expect(funnel.getByText(/Ещё .* заказ/)).toBeVisible();
  await expect(products.getByText('Телевизор LG OLED evo C4 65 дюймов 4K', { exact: true })).toBeVisible();
  await expect(products.getByText('Игровая консоль Sony PlayStation 5 Slim', { exact: true })).toHaveCount(0);
  expect(await overflowingCards(page)).toEqual([]);
  const overviewShot = testInfo.outputPath('moysklad-compact-overview-dark.png');
  await page.screenshot({ path: overviewShot, fullPage: true });
  await testInfo.attach('moysklad-compact-overview-dark', { path: overviewShot, contentType: 'image/png' });

  await page.goto('/sklad/channels');
  const geography = page.getByRole('heading', { name: /География заказов/ }).locator('xpath=ancestor::section[1]');
  await expect(geography.getByText(/Ещё 3 города в отчёте · Без города:/)).toBeVisible();
  await expect(geography.getByText('Нижний Новгород', { exact: true })).toBeVisible();
  await expect(geography.getByText('Ростов-на-Дону', { exact: true })).toHaveCount(0);
  expect(await overflowingCards(page)).toEqual([]);
  const channelsShot = testInfo.outputPath('moysklad-compact-channels-dark.png');
  await page.screenshot({ path: channelsShot, fullPage: true });
  await testInfo.attach('moysklad-compact-channels-dark', { path: channelsShot, contentType: 'image/png' });
});

test('full reports retain every row hidden by compact-card limits', async ({ page }) => {
  await bootDemo(page, '/metrics/ms-funnel', { theme: 'dark', msMax: true });
  await expect(page.getByText('Ожидает оплаты', { exact: true })).toBeVisible();
  expect(await overflowingCards(page)).toEqual([]);

  await page.goto('/metrics/ms-products?view=ranking');
  await expect(page.getByText('Игровая консоль Sony PlayStation 5 Slim', { exact: true })).toBeVisible();
  expect(await overflowingCards(page)).toEqual([]);

  await page.goto('/metrics/ms-geography');
  await expect(page.getByText('Челябинск', { exact: true })).toBeVisible();
  await expect(page.getByText(/Без города доставки/)).toBeVisible();
  expect(await overflowingCards(page)).toEqual([]);
});
