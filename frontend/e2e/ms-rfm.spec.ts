import { expect, test } from '@playwright/test';
import { bootDemo, overflowingCards } from './helpers';

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'MoySklad analytics is desktop-first');
  await bootDemo(page, '/sklad/clients', { theme: 'dark' });
});

test('MoySklad RFM is an honest compact distribution with a canonical full page', async ({ page }) => {
  const card = page.getByRole('heading', { name: 'RFM-сегменты', exact: true }).locator('xpath=ancestor::section[1]');
  const metric = card.getByRole('group', { name: 'Метрика RFM-сегментов' });
  await expect(metric.getByRole('button', { name: 'Клиенты' })).toHaveAttribute('aria-pressed', 'true');
  await expect(card.getByText('Чемпионы', { exact: true })).toBeVisible();
  await expect(card.getByText('Под риском', { exact: true })).toBeVisible();
  await expect(card.getByText(/оценки R\/F\/M относительны покупателям этого окна/i)).toBeVisible();
  await expect(card.getByText(/Без контрагента: 3 заказа — не сегментированы/)).toBeVisible();

  await metric.getByRole('button', { name: 'Выручка' }).click();
  await expect(metric.getByRole('button', { name: 'Выручка' })).toHaveAttribute('aria-pressed', 'true');
  await card.getByRole('button', { name: 'Развернуть виджет «RFM-сегменты»' }).click();

  await expect(page).toHaveURL(/\/metrics\/ms-rfm$/);
  await expect(page.getByRole('heading', { name: 'RFM-сегменты', level: 1 })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Сегменты покупателей', exact: true })).toBeVisible();
  await expect(page.getByText(/в среднем R 2 дн\. · F 4,2 заказа · M/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Сравнение' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'О метрике' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await overflowingCards(page)).toEqual([]);
});
