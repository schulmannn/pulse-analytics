import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * Регресс прод-бага «демо-Instagram = error-карточка»: публичное демо (pulse_demo=1, канал 0)
 * живёт БЕЗ серверной сессии, поэтому любой /api/ig/* запрос, ушедший в сеть, на проде получает
 * 401 «Сессия истекла» от requireAuth и IG-шелл целиком падает в «Не удалось загрузить данные
 * Instagram». Инвариант: в демо весь IG-неймспейс резолвится клиентскими фикстурами (ленивый
 * чанк demoIgFixtures) — ноль сетевых /api/ig запросов и живой контент на каждой IG-странице.
 * Тест на роут, не один обход: четыре навигации не влезают в 45с на холодном dev-сервере.
 */
const IG_ROUTES = ['/instagram', '/instagram/analytics', '/instagram/content', '/instagram/audience'];

function collectIgRequests(page: Page): string[] {
  const igHits: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/ig/')) igHits.push(path);
  });
  return igHits;
}

for (const route of IG_ROUTES) {
  test(`демо ${route} рендерится из клиентских фикстур без сетевых /api/ig запросов`, async ({ page }) => {
    const igHits = collectIgRequests(page);
    await bootDemo(page, route, { theme: 'dark' });
    // Connect-панель рендерится ШЕЛЛОМ только после успешной загрузки IG-кластера — на любом
    // брейкпоинте это и есть признак «данные пришли» (error-ветка её не содержит). Маркер
    // СОЗНАТЕЛЬНО переехал с «Демо-режим» на «Instagram не подключён»: панель дублировала
    // глобальный демо-баннер оболочки и врала реальному пользователю без подключения (аудит #554,
    // D18). Инвариант спека прежний — панель на месте, значит IG-кластер жив.
    await expect(page.getByRole('heading', { name: 'Instagram не подключён', exact: true })).toBeVisible();
    await expect(page.getByText('Не удалось загрузить данные Instagram')).toHaveCount(0);
    if (route === '/instagram/audience') {
      // Богатая часть фикстур (breakdowns) реально дошла до секций, а не только шелл ожил.
      await expect(page.getByRole('heading', { name: 'Демография' })).toBeVisible();
    }
    expect(igHits).toEqual([]);
  });
}

// IG-виджет Главной на «Всё»: в демо архива нет (запрос выключен), и окно обязано взять живой
// фолбэк фикстур, как страницы useIgData. Раньше хук выключал инсайты на архивном окне целиком, и
// карточка печатала «Нет данных за период».
test('демо: IG-виджет Главной на «Всё» берёт живой фолбэк, а не «Нет данных за период»', async ({ page }) => {
  const igHits = collectIgRequests(page);
  await page.addInitScript(() => {
    localStorage.setItem('pulse_home_blocks', JSON.stringify({ keys: ['custom:igall'] }));
    localStorage.setItem('pulse_widget_configs', JSON.stringify([{ id: 'igall', metricId: 'ig.reach', viz: 'line', period: 0 }]));
  });
  await bootDemo(page, '/home', { theme: 'dark' });
  const card = page.locator('section').filter({ has: page.locator('[data-source-identity]', { hasText: 'Instagram' }) });
  await expect(card).toHaveCount(1);
  await expect(card.locator('svg[data-chart-kind]').first()).toBeVisible();
  await expect(card.getByText('Нет данных за период')).toHaveCount(0);
  expect(igHits).toEqual([]);
});
