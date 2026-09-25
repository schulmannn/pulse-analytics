import { expect, test, type Page } from '@playwright/test';

/**
 * Отзыв токена МойСклада/Метрики — «Переподключить», а не выход на /login и не «Повторить».
 *
 * Сервер отдаёт отзыв сегодня 401 + ms/ym_token_revoked, а после единого sendSourceError — 409 +
 * source_reauth. Обе формы проверяются на всех поверхностях источника: Обзор, страница метрики и
 * виджет Главной. Контроль: 401 без кода — истёкшая сессия Atlavue — по-прежнему ведёт на /login.
 *
 * Boot БЕЗ pulse_demo: в демо 401-редирект выключен целиком, и спек прошёл бы вхолостую. Весь API
 * мокается роутами (образец ig-reauth.spec).
 */

type Form = 'legacy' | 'unified' | 'session';

const MS_CHANNEL = 7;
const YM_CHANNEL = 9;

function revoked(form: Form, source: 'ms' | 'ym'): { status: number; body: Record<string, string> } {
  if (form === 'session') return { status: 401, body: { error: 'Сессия истекла, войди снова' } };
  if (form === 'unified') {
    return { status: 409, body: { error: 'Токен отозван — переподключите источник', code: 'source_reauth', source } };
  }
  return source === 'ms'
    ? { status: 401, body: { error: 'Токен отозван МойСкладом — переподключите источник', code: 'ms_token_revoked' } }
    : { status: 401, body: { error: 'Токен отозван Яндексом — переподключите источник', code: 'ym_token_revoked' } };
}

async function boot(page: Page, path: string, form: Form, opts: { channel: number; home?: boolean }) {
  let sessionGone = false;
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request();
    const urlPath = new URL(request.url()).pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    // Истёкшая сессия (form 'session') — это и есть «сессии нет»: как только data-роут ответил 401
    // без кода, /me тоже отвечает 401, и /login не отскакивает обратно в приложение.
    if (urlPath === '/api/auth/me') {
      return sessionGone
        ? json(401, { error: 'Сессия истекла, войди снова' })
        : json(200, { uid: 42, email: 'owner@pulse.local', role: 'user', avatar: null });
    }
    if (urlPath === '/api/channels' && request.method() === 'GET') {
      return json(200, {
        enabled: true,
        channels: [
          { id: MS_CHANNEL, username: 'shop', title: 'shop', status: 'active', source: 'ms' },
          { id: YM_CHANNEL, username: null, title: 'site', status: 'active', source: 'ym', ig_connected: false },
        ],
      });
    }
    // Учётка на месте: статус читается из БД и не ходит к провайдеру. Отказывает сам провайдер —
    // на каждом data-роуте.
    if (urlPath === '/api/ms/status') return json(200, { connected: true, org_name: 'shop' });
    if (urlPath === '/api/ym/status') return json(200, { connected: true, counter_name: 'site', counter_id: '1', site: 'site.ru' });
    if (urlPath.startsWith('/api/ms/')) {
      const { status, body } = revoked(form, 'ms');
      if (form === 'session') sessionGone = true;
      return json(status, body);
    }
    if (urlPath.startsWith('/api/ym/')) {
      const { status, body } = revoked(form, 'ym');
      return json(status, body);
    }
    if (urlPath === '/api/tg/qr/status') return json(200, { connected: false, server_ready: false });
    if (urlPath === '/api/ig/oauth/status') return json(200, { connected: false, server_ready: false, env_fallback: false });
    if (urlPath === '/api/prefs') return json(200, request.method() === 'GET' ? {} : { ok: true });
    return json(404, { error: 'not_stubbed' });
  });
  await page.addInitScript(
    ({ channel, home }) => {
      localStorage.setItem('pulse_channel', String(channel));
      localStorage.setItem('pulse_theme', 'dark');
      if (home) {
        localStorage.setItem('pulse_home_blocks', JSON.stringify({ keys: ['custom:msw', 'custom:ymw'] }));
        localStorage.setItem(
          'pulse_widget_configs',
          JSON.stringify([
            { id: 'msw', metricId: 'ms.revenue', viz: 'line' },
            { id: 'ymw', metricId: 'ym.visits', viz: 'line' },
          ]),
        );
      }
    },
    { channel: opts.channel, home: opts.home ?? false },
  );
  await page.goto(path);
}

for (const form of ['legacy', 'unified'] as const) {
  test(`${form}: Обзор МойСклада зовёт переподключить и не разлогинивает`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop-обзор склада');
    await boot(page, '/sklad', form, { channel: MS_CHANNEL });

    await expect(page.getByText('Токен МойСклада отозван').first()).toBeVisible({ timeout: 15_000 });
    const cta = page.getByRole('link', { name: 'Переподключить МойСклад' });
    await expect(cta).toHaveAttribute('href', '/connect?source=moysklad');
    await expect(page).toHaveURL(/\/sklad$/);
    await expect(page.getByRole('button', { name: 'Повторить' })).toHaveCount(0);
  });

  test(`${form}: страница метрики МойСклада — «Переподключить» внутри оболочки`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop-страница метрики');
    await boot(page, '/metrics/ms-revenue', form, { channel: MS_CHANNEL });

    // Шапка страницы остаётся: сбой доступа не уносит «назад» и имя метрики.
    await expect(page.getByRole('heading', { name: 'Выручка', level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Токен МойСклада отозван').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Переподключить' }).first()).toHaveAttribute('href', '/connect?source=moysklad');
    await expect(page).toHaveURL(/\/metrics\/ms-revenue/);
    await expect(page.getByRole('button', { name: 'Повторить' })).toHaveCount(0);
  });

  test(`${form}: страница метрики Метрики — «Переподключить Метрику»`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop-страница метрики');
    await boot(page, '/metrics/ym-visits', form, { channel: YM_CHANNEL });

    await expect(page.getByRole('heading', { name: 'Визиты', level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Токен Яндекса отозван')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Переподключить Метрику' })).toHaveAttribute('href', '/connect?source=metrika');
    await expect(page).toHaveURL(/\/metrics\/ym-visits/);
  });

  // Главная рендерится и на телефоне: путь сбоя обязан работать там же, раскладка — та же.
  test(`${form}: виджеты Главной МойСклада и Метрики зовут переподключить`, async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop-1440' && testInfo.project.name !== 'mobile-430',
      'Доска Главной: десктоп и телефон',
    );
    await boot(page, '/home', form, { channel: MS_CHANNEL, home: true });

    const ms = page.locator('section').filter({ hasText: 'Токен МойСклада отозван' });
    const ym = page.locator('section').filter({ hasText: 'Токен Яндекса отозван' });
    await expect(ms.getByRole('link', { name: 'Переподключить' })).toHaveAttribute('href', '/connect?source=moysklad', {
      timeout: 15_000,
    });
    await expect(ym.getByRole('link', { name: 'Переподключить' })).toHaveAttribute('href', '/connect?source=metrika');
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByText('это сбой запроса, а не пустой период')).toHaveCount(0);
    // Состояние доступа не раздвигает страницу вбок.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test('401 без кода — истёкшая сессия Atlavue — по-прежнему ведёт на /login', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop-обзор склада');
  await boot(page, '/sklad', 'session', { channel: MS_CHANNEL });
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
});
