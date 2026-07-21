import { expect, test, type Page } from '@playwright/test';

/**
 * Мастер коллектор-сетапа на /connect (вкладка «Через агента»): создание ключа прямо в шаге 1,
 * пошаговая навигация с прогрессом, возврат по пройденным шагам и живая проверка агента на финале
 * (поллинг collector-status: «ждём первый прогон» → «Агент на связи»).
 *
 * Boot БЕЗ pulse_demo: клиентские demoFixtures кроют collector-status и «съедают» сеть (и режут
 * writes) — здесь весь API замокан роутами с состоянием в замыкании (паттерн ig-content.spec),
 * чтобы управлять и созданием ключа, и переключением статуса агента.
 */
async function bootWizard(page: Page) {
  let statusCalls = 0;
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/api/auth/me') return json(200, { uid: 42, email: 'owner@pulse.local', role: 'user', avatar: null });
    if (path === '/api/channels' && request.method() === 'GET') {
      return json(200, { enabled: true, channels: [{ id: 7, username: 'demo_channel', title: 'Demo Channel', status: 'active', source: 'collector', ig_connected: false }] });
    }
    if (path === '/api/channels/7/key' && request.method() === 'POST') {
      return json(200, { id: 1, key_prefix: 'pa_live', label: 'локальный коллектор', created_at: new Date().toISOString(), revoked: false, key: 'pa_live_e2e_one_time_key' });
    }
    if (/^\/api\/channels\/7\/collector-status$/.test(path)) {
      statusCalls += 1;
      return json(
        200,
        statusCalls <= 1
          ? { status: null }
          : { status: { last_success_at: new Date().toISOString(), last_error: null, stale: false, stale_after_hours: 30 } },
      );
    }
    if (path === '/api/tg/qr/status') return json(200, { connected: false, server_ready: false });
    if (path === '/api/ig/oauth/status') return json(200, { connected: false, server_ready: false, env_fallback: false });
    return json(404, { error: 'not_stubbed' });
  });
  await page.addInitScript(() => {
    localStorage.setItem('pulse_channel', '7');
    localStorage.setItem('pulse_theme', 'dark');
  });
  await page.goto('/connect?source=telegram&tab=agent');
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
}

test('collector wizard creates a key, walks steps, live check turns green', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile-430', 'Desktop/tablet поверхность подключений');
  await bootWizard(page);

  const steps = page.getByRole('list', { name: 'Шаги настройки коллектора' });
  await steps.waitFor({ timeout: 15_000 });

  // Шаг 1: ключ создаётся прямо в мастере, показывается один раз, копирование работает.
  await page.getByRole('button', { name: 'Создать ключ' }).click();
  await expect(page.getByText('Скопируйте сейчас — повторно ключ не показывается.')).toBeVisible();
  await expect(page.getByText('pa_live_e2e_one_time_key')).toBeVisible();

  // Вперёд по шагам: контент меняется.
  const next = page.getByRole('button', { name: 'Далее' });
  await next.click();
  await expect(page.getByText('Создайте Telegram-приложение')).toBeVisible();
  await next.click();
  await expect(page.getByText('Получите строку сессии (один раз)')).toBeVisible();
  await next.click();
  await expect(page.getByText('Заполните .env рядом с агентом')).toBeVisible();
  await next.click();

  // Шаг 5: сначала честное ожидание, после следующего 5с-полла — зелёная связь.
  const live = page.getByTestId('collector-live-check');
  await expect(live).toContainText('Ждём первый прогон агента');
  await expect(live).toContainText('Агент на связи', { timeout: 10_000 });
  await expect(live.getByRole('link', { name: 'Открыть дашборд →' })).toBeVisible();

  // Назад по прогресс-шапке: пройденный шаг кликабелен, контент возвращается.
  await steps.getByRole('button', { name: /Сессия/ }).click();
  await expect(page.getByText('Получите строку сессии (один раз)')).toBeVisible();
});
