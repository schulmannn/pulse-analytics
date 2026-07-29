import { expect, test } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * Виртуализация длинных списков (useVirtualRows). Первая страница сегмента — 50 строк
 * (классический рендер, ниже порога 120), «Показать ещё» добирает по 200 — список обязан
 * перейти в виртуальное окно, а прокрутка внутреннего desktop-скроллера
 * [data-dashboard-scroll] — дорисовывать хвост.
 */
test.beforeEach(async ({ browserName: _browserName }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'MoySklad analytics is desktop-first');
});

test('RFM segment customers switch from classic render to a virtual window', async ({ page }) => {
  await bootDemo(page, '/metrics/ms-rfm?segment=champions', { theme: 'dark' });
  // Первая страница (50 < порога): классический список, без data-virtualized.
  await expect(page.getByText('300 покупателей')).toBeVisible();
  await expect(page.getByText('Покупатель 1', { exact: true })).toBeVisible();
  await expect(page.locator('ul[data-virtualized]')).toHaveCount(0);

  // «Показать ещё» добирает 200 → 250 строк → виртуальное окно (DOM сильно меньше списка).
  await page.getByRole('button', { name: 'Показать ещё' }).click();
  const list = page.locator('ul[data-virtualized="true"]');
  await expect(list).toHaveCount(1);
  const windowCount = await list.locator('li').count();
  expect(windowCount).toBeGreaterThan(0);
  expect(windowCount).toBeLessThan(120);

  // Прокрутка ВНУТРЕННЕГО скроллера дорисовывает хвост; нумерация — по абсолютному индексу.
  const scroller = page.locator('[data-dashboard-scroll]');
  await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(page.getByText('Покупатель 250', { exact: true })).toBeVisible();
  const row250 = page.locator('li', { hasText: 'Покупатель 250' });
  await expect(row250.locator('span').first()).toHaveText('250');

  // Последняя страница: хвост (300) достижим скроллом, DOM всё ещё окно.
  await page.getByRole('button', { name: 'Показать ещё' }).click();
  await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(page.getByText('Покупатель 300', { exact: true })).toBeVisible();
  expect(await list.locator('li').count()).toBeLessThan(120);
});

test('stock table virtualizes 200 rows against the dashboard scroller, not the horizontal wrap', async ({ page }) => {
  // Демо-фикстура остатков — 5 строк; для окна нужен полный склад. Route-мок регистрируется
  // ПОСЛЕ bootDemo-catch-all и потому перехватывает первым (Playwright матчит роуты LIFO).
  await bootDemo(page, '/', { theme: 'dark' });
  await page.route(/\/api\/ms\/stock\b/, (r) =>
    r.fulfill({
      json: {
        window_days: 30,
        rows: Array.from({ length: 200 }, (_, index) => ({
          id: `stock-${index + 1}`,
          name: `Товар ${index + 1}`,
          stock: 500 - index * 2,
          reserve: index % 7,
          sold_window: 100 - (index % 90),
          days_left: index < 150 ? index + 1 : null,
        })),
      },
    }),
  );
  await page.goto('/metrics/ms-stock');
  await expect(page.getByRole('heading', { name: 'Остатки', level: 1 })).toBeVisible({ timeout: 20_000 });

  // Виртуальное окно: tbody помечен, DOM держит меньше половины склада.
  const body = page.locator('tbody[data-virtualized="true"]');
  await expect(body).toHaveCount(1);
  await expect(page.getByText('Товар 1', { exact: true })).toBeVisible();
  const windowCount = await body.locator('tr[data-index]').count();
  expect(windowCount).toBeGreaterThan(0);
  expect(windowCount).toBeLessThan(120);

  // Хвост дорисовывается прокруткой ВЕРТИКАЛЬНОГО скроллера шелла — не горизонтальной обёртки.
  const scroller = page.locator('[data-dashboard-scroll]');
  await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(page.getByText('Товар 200', { exact: true })).toBeVisible();
  expect(await body.locator('tr[data-index]').count()).toBeLessThan(120);
});
