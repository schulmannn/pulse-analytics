import { expect, test } from '@playwright/test';
import { bootDemo, overflowingCards } from './helpers';

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'MoySklad analytics is desktop-first');
});

test('product card stays a compact ranking; expanded opens on concentration and toggles metric/view', async ({ page }, testInfo) => {
  await bootDemo(page, '/sklad', { theme: 'dark' });
  const card = page.getByRole('heading', { name: 'Товары', exact: true }).locator('xpath=ancestor::section[1]');

  // Компакт неизменен: «Рейтинг» + метрика + строки рейтинга, без вида концентрации.
  await expect(card.getByText('Рейтинг', { exact: true })).toBeVisible();
  await expect(card.getByRole('group', { name: 'Метрика рейтинга товаров' })).toBeVisible();
  await expect(card.getByText('Товар A', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Концентрация' })).toHaveCount(0);

  // «Развернуть» ведёт на полностраничный отчёт /metrics/ms-products (не модалка), открытый на концентрации.
  await page.getByRole('button', { name: 'Развернуть виджет «Товары»' }).click();
  await expect(page).toHaveURL(/\/metrics\/ms-products$/);
  await expect(page.getByRole('heading', { name: 'Товары', level: 1 })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Разворот открывается на «Концентрации».
  const viewSwitch = page.getByRole('group', { name: 'Вид отчёта товаров' });
  await expect(viewSwitch.getByRole('button', { name: 'Концентрация' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/Доля топ-10/)).toBeVisible();
  await expect(page.getByText('100.0%', { exact: true })).toBeVisible();
  await expect(page.getByText('Товаров в отчёте')).toBeVisible();
  await expect(page.getByText('Общая маржа')).toBeVisible();
  await expect(page.getByText('Убыточных товаров')).toBeVisible();
  await expect(page.getByText(/дают эту долю положительной выручки/)).toBeVisible();

  const concentrationShot = testInfo.outputPath('moysklad-product-concentration-dark.png');
  await page.screenshot({ path: concentrationShot, fullPage: true });
  await testInfo.attach('moysklad-product-concentration-dark', { path: concentrationShot, contentType: 'image/png' });

  // Переключение метрики концентрации на валовую прибыль — своя sort-specific выборка.
  const profitRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/api/ms/top-products' && url.searchParams.get('sort') === 'profit';
  });
  await page.getByRole('group', { name: 'Метрика концентрации' }).getByRole('button', { name: 'Валовая прибыль' }).click();
  await profitRequest;
  await expect(page.getByText(/дают эту долю положительной валовой прибыли/)).toBeVisible();

  // Вид «Рейтинг» возвращает полный список и свой селектор сортировки.
  await viewSwitch.getByRole('button', { name: 'Рейтинг' }).click();
  await expect(page.getByRole('group', { name: 'Метрика рейтинга товаров' })).toBeVisible();
  await expect(page.getByText('Товар A', { exact: true })).toBeVisible();

  expect(await overflowingCards(page)).toEqual([]);

  const rankingShot = testInfo.outputPath('moysklad-product-ranking-dark.png');
  await page.screenshot({ path: rankingShot, fullPage: true });
  await testInfo.attach('moysklad-product-ranking-dark', { path: rankingShot, contentType: 'image/png' });
});
