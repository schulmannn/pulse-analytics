import { expect, test } from '@playwright/test';
import { bootDemo, overflowingCards } from './helpers';

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'MoySklad analytics is desktop-first');
});

test('product ranking switches between revenue, profit and margin without clipping the card', async ({ page }, testInfo) => {
  await bootDemo(page, '/sklad', { theme: 'dark' });
  const card = page.getByRole('heading', { name: 'Товары', exact: true }).locator('xpath=ancestor::section[1]');
  const metric = card.getByRole('group', { name: 'Метрика рейтинга товаров' });

  await expect(card.getByText('Товар A', { exact: true })).toBeVisible();
  const marginRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/api/ms/top-products' && url.searchParams.get('sort') === 'margin';
  });
  await metric.getByRole('button', { name: 'Маржа' }).click();
  await marginRequest;
  await expect(card.getByText('Товар B', { exact: true })).toBeVisible();
  await expect(card.getByText('50.0%', { exact: true })).toBeVisible();

  await metric.getByRole('button', { name: 'Прибыль' }).click();
  await expect(card.getByText('Товар B', { exact: true })).toBeVisible();
  expect(await overflowingCards(page)).toEqual([]);

  const shot = testInfo.outputPath('moysklad-product-profitability-dark.png');
  await page.screenshot({ path: shot, fullPage: true });
  await testInfo.attach('moysklad-product-profitability-dark', { path: shot, contentType: 'image/png' });
});

test('customer cards expose repeat revenue and the shared independent-window explorer', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await bootDemo(page, '/sklad/clients', { theme: 'dark' });
  const repeatCard = page.getByRole('heading', { name: 'Повторные покупки' }).locator('xpath=ancestor::section[1]');
  await expect(repeatCard.getByText('Доля повторной выручки')).toBeVisible();

  // «Развернуть» ведёт на полностраничную метрику /metrics/ms-customers (общий independent-window
  // explorer), а не в модальный оверлей.
  await page.getByRole('button', { name: 'Развернуть виджет «Покупатели»' }).click();
  await expect(page).toHaveURL(/\/metrics\/ms-customers$/);
  // The MS metric page is a lazy chunk. Allow the cold Vite transform to finish when this suite
  // runs in parallel with the all-routes parity pass; the production bundle is already built.
  await expect(page.getByRole('heading', { name: 'Покупатели', level: 1 })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const metric = page.getByRole('group', { name: 'Метрика покупателей' });
  const window = page.getByRole('group', { name: 'Окно', exact: true });
  await expect(metric).toBeVisible();
  await expect(window.getByRole('button', { name: '30д' })).toHaveAttribute('aria-pressed', 'true');

  const request90 = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/api/ms/customers' && url.searchParams.get('days') === '90';
  });
  await window.getByRole('button', { name: '90д' }).click();
  await request90;
  await metric.getByRole('button', { name: 'Выручка' }).click();
  await expect(page.getByText('новые и повторные покупки', { exact: true })).toBeVisible();
  await metric.getByRole('button', { name: 'Доля повторных' }).click();
  await expect(page.getByText('доля повторной выручки', { exact: true })).toBeVisible();

  await page.getByRole('group', { name: 'Грануляция' }).getByRole('button', { name: 'Месяц' }).click();
  await page.getByRole('group', { name: 'Тип графика' }).getByRole('button', { name: 'Столбцы' }).click();
  await expect(page.locator('svg[data-chart-kind="bar"]')).toBeVisible();

  const shot = testInfo.outputPath('moysklad-customers-explorer-dark.png');
  await page.screenshot({ path: shot, fullPage: true });
  await testInfo.attach('moysklad-customers-explorer-dark', { path: shot, contentType: 'image/png' });
});
