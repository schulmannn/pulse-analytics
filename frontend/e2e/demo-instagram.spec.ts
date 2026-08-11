import { test, expect } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * Регресс прод-бага «демо-Instagram = error-карточка»: публичное демо (pulse_demo=1, канал 0)
 * живёт БЕЗ серверной сессии, поэтому любой /api/ig/* запрос, ушедший в сеть, на проде получает
 * 401 «Сессия истекла» от requireAuth и IG-шелл целиком падает в «Не удалось загрузить данные
 * Instagram». Инвариант: в демо весь IG-неймспейс резолвится клиентскими фикстурами — ноль
 * сетевых /api/ig запросов и живой контент на всех четырёх IG-страницах.
 */
const IG_ROUTES = ['/instagram', '/instagram/analytics', '/instagram/content', '/instagram/audience'];

test('демо-Instagram рендерится из клиентских фикстур без сетевых /api/ig запросов', async ({ page }) => {
  const igHits: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/ig/')) igHits.push(path);
  });

  await bootDemo(page, IG_ROUTES[0], { theme: 'dark' });
  for (const route of IG_ROUTES) {
    if (!page.url().includes(route)) {
      await page.goto(route);
      await page.locator('main').waitFor({ state: 'visible' });
    }
    // Connect-панель «Демо-режим» рендерится ШЕЛЛОМ только после успешной загрузки IG-кластера —
    // на любом брейкпоинте это и есть признак «данные пришли» (error-ветка её не содержит).
    await expect(page.getByRole('heading', { name: 'Демо-режим', exact: true })).toBeVisible();
    await expect(page.getByText('Не удалось загрузить данные Instagram')).toHaveCount(0);
  }
  await expect(page.getByRole('heading', { name: 'Демография' })).toBeVisible();

  expect(igHits).toEqual([]);
});
