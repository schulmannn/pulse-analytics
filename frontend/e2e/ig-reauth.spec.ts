import { expect, test, type Page } from '@playwright/test';

/**
 * Истёкший доступ к Instagram обязан быть ВИДИМЫМ состоянием, а не бесконечным скелетоном.
 *
 * Регрессия из прода (@bynotem, 1 сентября 2026): токен истёк, /api/ig/profile отвечал 502,
 * /api/ig/insights намеренно деградировал до пустого 200 — и правило `error = профиль И insights`
 * никогда не срабатывало. Экран крутил скелетон, /connect писал «Подключён», а в логах не было ни
 * строки. Здесь пришпилены обе поверхности: экран Instagram и пилюля источника.
 *
 * Boot БЕЗ pulse_demo: клиентские demoFixtures отдают IG-пути ДО сети, и любой route-стаб под ними
 * не срабатывает (именно так вхолостую проходил ig-period-morph). Весь API мокается роутами.
 */

const DAY = 24 * 60 * 60 * 1000;
const EXPIRED_AT = new Date(Date.now() - 3 * DAY).toISOString();

async function bootExpiredIg(page: Page, path: string) {
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request();
    const urlPath = new URL(request.url()).pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (urlPath === '/api/auth/me') return json(200, { uid: 42, email: 'owner@pulse.local', role: 'user', avatar: null });
    if (urlPath === '/api/channels' && request.method() === 'GET') {
      return json(200, {
        enabled: true,
        channels: [{ id: 9, username: 'bynotem', title: 'bynotem', status: 'active', source: 'ig', ig_connected: true }],
      });
    }
    // Ровно то, что отдаёт прод с протухшим токеном: статус подключения жив и честен про срок…
    if (urlPath === '/api/ig/oauth/status') {
      return json(200, {
        server_ready: true, env_fallback: false, connected: true, channel_id: 9,
        username: 'bynotem', ig_user_id: 'igid123', connected_at: '2026-07-03T10:00:00',
        token_expires_at: EXPIRED_AT, token_state: 'expired',
      });
    }
    // …профиль падает различимым кодом…
    if (urlPath === '/api/ig/profile') {
      return json(409, { error: 'Токен Instagram истёк — переподключите', code: 'ig_reauth', request_id: 'test' });
    }
    // …а insights честно деградируют до пустого 200 — именно это раньше маскировало ошибку.
    if (urlPath === '/api/ig/insights') return json(200, { data: [] });
    if (urlPath.startsWith('/api/ig/')) return json(200, { data: [] });
    if (urlPath === '/api/tg/qr/status') return json(200, { connected: false, server_ready: false });
    if (urlPath === '/api/prefs') return json(200, {});
    return json(404, { error: 'not_stubbed' });
  });
  await page.addInitScript(() => {
    localStorage.setItem('pulse_channel', '9');
    localStorage.setItem('pulse_theme', 'dark');
  });
  await page.goto(path);
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
}

test('экран Instagram показывает «доступ истёк» вместо скелетона', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop-поверхность Instagram');
  await bootExpiredIg(page, '/instagram');

  // 2 секунды — потолок из ТЗ: состояние известно сразу, ждать ретраев нечего.
  await expect(page.getByText(/Доступ к Instagram истёк/)).toBeVisible({ timeout: 2_000 });
  await expect(page.getByRole('button', { name: 'Переподключить' })).toBeVisible();
  // Скелетона на экране быть не должно: состояние доступа старше загрузки.
  await expect(page.locator('[data-skeleton], .animate-pulse')).toHaveCount(0);
  // И это не общая ошибка «попробуйте ещё раз» — путь наружу другой.
  await expect(page.getByText('Не удалось загрузить данные Instagram')).toHaveCount(0);
});

test('/connect: пилюля Instagram говорит «Переподключить», а не «Подключён»', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop-поверхность /connect');
  await bootExpiredIg(page, '/connect?source=instagram');

  const panel = page.locator('div').filter({ has: page.getByRole('heading', { name: 'Instagram', exact: true }) }).last();
  await expect(panel.getByText('Переподключить', { exact: true }).first()).toBeVisible({ timeout: 5_000 });
  await expect(panel.getByText('Подключён', { exact: true })).toHaveCount(0);
  // Подпись узла орбиты тоже честная; сам дизайн орбиты не менялся.
  await expect(page.getByRole('radio', { name: /Instagram — переподключить/ })).toBeAttached();
});
