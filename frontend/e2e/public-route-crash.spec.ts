import { test, expect } from '@playwright/test';

/**
 * Корневой ErrorBoundary покрывает и ПУБЛИЧНЫЕ маршруты (/login, /register, /privacy). Раньше он
 * оборачивал только protected-оболочку: падение динамического импорта на публичной странице после
 * единственной попытки перезагрузки (lazyWithReload) давало белый экран.
 *
 * Чанк роняем сетевым abort'ом. Заодно проверяется, что одноразовость перезагрузки цела: первый
 * фейл перезагружает вкладку (флаг в sessionStorage), второй — честно всплывает в boundary.
 */
test.describe('публичный маршрут: упавший lazy-чанк', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'поведение не зависит от брейкпоинта');
    // Крэш-репорт уходит в API — отвечаем заглушкой, чтобы прогон не зависел от бэкенда.
    await page.route(/^https?:\/\/[^/]+\/api\//, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    );
  });

  test('видим fallback boundary, а не белый экран; перезагрузка была ровно одна', async ({ page }) => {
    let attempts = 0;
    await page.route('**/src/pages/Legal.tsx*', (r) => {
      attempts += 1;
      return r.abort();
    });

    // waitUntil:'commit' — lazyWithReload перезагружает вкладку прямо во время загрузки, и ожидание
    // 'load' здесь гонялось бы с этой навигацией.
    await page.goto('/privacy', { waitUntil: 'commit' });

    await expect(page.getByRole('heading', { name: 'Не удалось загрузить раздел' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('button', { name: 'Обновить' })).toBeVisible();
    // Одна автоперезагрузка = ровно две попытки импорта; третьей (цикла reload) быть не должно.
    expect(attempts, `попыток импорта: ${attempts}`).toBe(2);
    expect(await page.evaluate(() => sessionStorage.getItem('chunk-reload-once'))).toBe('1');

    // Экран не белый: fallback реально отрисован в корне приложения.
    const rootMarkup = await page.evaluate(() => document.getElementById('root')?.innerHTML ?? '');
    expect(rootMarkup.length).toBeGreaterThan(0);
  });

  test('тот же fallback на /login (auth-маршрут вне protected-оболочки)', async ({ page }) => {
    // Флаг уже стоит — первая же ошибка импорта обязана всплыть в boundary, без перезагрузки.
    await page.addInitScript(() => sessionStorage.setItem('chunk-reload-once', '1'));
    await page.route('**/src/pages/Auth.tsx*', (r) => r.abort());

    await page.goto('/login', { waitUntil: 'commit' });
    await expect(page.getByRole('heading', { name: 'Не удалось загрузить раздел' })).toBeVisible({
      timeout: 30_000,
    });
  });
});
