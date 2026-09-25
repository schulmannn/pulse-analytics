import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * Тот же регресс, что закрыт для Instagram (demo-instagram.spec), но для МойСклада и Метрики:
 * публичное демо живёт БЕЗ серверной сессии, а /api/ms/* и /api/ym/* стоят за requireAuth — любой
 * ушедший в сеть запрос получал 401 и рабочая поверхность показывала «Не удалось получить данные».
 * Инвариант: оба неймспейса резолвятся клиентскими фикстурами (ленивые чанки demoMsFixtures /
 * demoYmFixtures) — ноль сетевых запросов и живые числа на странице.
 *
 * `msFixtures: true` обязателен: по умолчанию bootDemo возвращает эти неймспейсы сети, чтобы не
 * подменять собственные payload'ы МС-спеков (см. helpers.bootDemo).
 */
const ROUTES: { route: string; prefix: string; anchor: string }[] = [
  { route: '/sklad', prefix: '/api/ms/', anchor: 'Выручка' },
  { route: '/sklad/clients', prefix: '/api/ms/', anchor: 'Покупатели' },
  { route: '/metrika', prefix: '/api/ym/', anchor: 'Визиты' },
];

function collectHits(page: Page, prefix: string): string[] {
  const hits: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith(prefix)) hits.push(path);
  });
  return hits;
}

for (const { route, prefix, anchor } of ROUTES) {
  test(`демо ${route} рендерится из клиентских фикстур без сетевых ${prefix} запросов`, async ({ page }) => {
    const hits = collectHits(page, prefix);
    await bootDemo(page, route, { msFixtures: true });
    const card = page.getByRole('heading', { name: anchor, exact: true }).locator('xpath=ancestor::section[1]');
    await expect(card).toBeVisible();
    // Цифры в теле карточки = фикстура доехала до данных, а не только шапка отрисовалась.
    await expect(card).toContainText(/\d/);
    await expect(page.getByText('Не удалось получить данные')).toHaveCount(0);
    expect(hits).toEqual([]);
  });
}
