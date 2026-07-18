import { expect, test } from '@playwright/test';
import { bootDemo, overflowingCards } from './helpers';

const ROUTES = [
  ['/metrics/ms-revenue', 'Выручка'],
  ['/metrics/ms-orders', 'Заказы'],
  ['/metrics/ms-aov', 'Средний чек'],
  ['/metrics/ms-customers', 'Покупатели'],
  ['/metrics/ms-repeat', 'Повторные покупки'],
  ['/metrics/ms-channels', 'Каналы продаж'],
  ['/metrics/ms-funnel', 'Воронка статусов'],
  ['/metrics/ms-products', 'Товары'],
  ['/metrics/ms-returns', 'Возвраты'],
  ['/metrics/ms-sales-channels', 'Продажи по каналам'],
  ['/metrics/ms-geography', 'География заказов'],
  ['/metrics/ms-top-customers', 'Топ покупателей'],
  ['/metrics/ms-cohorts', 'Когорты'],
] as const;

test('all MoySklad drill targets use the shared full metric-page grammar', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'MoySklad analytics is desktop-first');
  await bootDemo(page, ROUTES[0][0], { theme: 'dark' });

  for (const [route, title] of ROUTES) {
    if (page.url().endsWith(route) === false) await page.goto(route);
    await expect(page).toHaveURL(new RegExp(`${route.replaceAll('/', '\\/')}$`));
    await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Сравнение' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'О метрике' })).toBeVisible();
    await expect(page.getByRole('link', { name: /МойСклад ·/ })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await overflowingCards(page)).toEqual([]);
  }
});
