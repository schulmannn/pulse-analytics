import { expect, test } from '@playwright/test';
import { bootDemo, overflowingCards } from './helpers';

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'MoySklad analytics is desktop-first');
});

test('product dynamics compares against the previous equal window with honest labels and URL persistence', async ({ page }, testInfo) => {
  await bootDemo(page, '/metrics/ms-products', { theme: 'dark' });
  await expect(page.getByRole('heading', { name: 'Товары', level: 1 })).toBeVisible();

  const viewSwitch = page.getByRole('group', { name: 'Вид отчёта товаров' });

  // Switching to «Динамика» fires the opt-in compare=prev request (compact card never does).
  const compareRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/api/ms/top-products' && url.searchParams.get('compare') === 'prev';
  });
  await viewSwitch.getByRole('button', { name: 'Динамика' }).click();
  await compareRequest;
  await expect(page).toHaveURL(/[?&]view=dynamics/);

  // Presence counts + four decision buckets with honest presence labels — no "removed"/"new catalog".
  await expect(page.getByText('Товаров в обоих окнах')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Наибольший рост' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Наибольшее падение' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Появились продажи' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Нет продаж в текущем периоде' })).toBeVisible();
  await expect(page.getByText('ранее продаж не было')).toBeVisible();
  await expect(page.getByText('сейчас продаж нет')).toBeVisible();
  await expect(page.getByText(/Предыдущее окно .+ Возвраты не вычитаются/)).toBeVisible();
  // A gainer reads as a muted percent (steep «ничего не кричит»), not a fabricated value.
  await expect(page.getByText('▲ 100.0%')).toBeVisible();

  expect(await overflowingCards(page)).toEqual([]);
  const shot = testInfo.outputPath('moysklad-product-dynamics-dark.png');
  await page.screenshot({ path: shot, fullPage: true });
  await testInfo.attach('moysklad-product-dynamics-dark', { path: shot, contentType: 'image/png' });

  // Reload restores the dynamics view straight from the URL. A direct dynamics URL must issue
  // only comparison requests, not a parallel ordinary ranking fetch. Vite dev + React StrictMode may
  // abort and restart the same query during its intentional double-mount, so cardinality is not the
  // invariant here; absence of the expensive plain report request is.
  const reloadProductRequests: string[] = [];
  const recordProductRequest = (request: { url(): string }) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/ms/top-products') reloadProductRequests.push(url.searchParams.get('compare') ?? 'plain');
  };
  page.on('request', recordProductRequest);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Наибольший рост' })).toBeVisible();
  await expect(viewSwitch.getByRole('button', { name: 'Динамика' })).toHaveAttribute('aria-pressed', 'true');
  expect(reloadProductRequests.length).toBeGreaterThan(0);
  expect(reloadProductRequests).not.toContain('plain');
  page.off('request', recordProductRequest);

  // Switching the change metric to «Штуки» persists change=units and reads values in pieces.
  await page.getByRole('group', { name: 'Метрика изменения' }).getByRole('button', { name: 'Штуки' }).click();
  await expect(page).toHaveURL(/[?&]change=units/);
  await expect(page.getByText('120 шт.')).toBeVisible();

  expect(await overflowingCards(page)).toEqual([]);

  // «Всё» has no previous equal window — honest unavailable, never an invented comparison.
  await page.getByRole('group', { name: 'Окно' }).first().getByRole('button', { name: 'Всё' }).click();
  await expect(page.getByText(/Для окна «Всё» предыдущего равного периода не существует/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Наибольший рост' })).toHaveCount(0);
  expect(await overflowingCards(page)).toEqual([]);
});
