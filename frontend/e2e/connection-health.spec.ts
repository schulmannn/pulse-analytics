import { expect, test, type Page } from '@playwright/test';

// Boot a revoked-session dashboard. `source` selects whether the tracked channel is the managed
// central channel (the production root cause: central collected through the owner's now-revoked
// session) or a managed QR channel. For central, central_owner=true is what gates the owner-only
// repair signal — a non-owner would see only the generic global behavior.
async function bootRevokedSession(page: Page, source: 'central' | 'qr', failFirstQrStart = false) {
  let qrStarts = 0;
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/api/auth/me') return json(200, { uid: 11, email: 'health@test.local', role: 'user', avatar: null });
    if (path === '/api/channels') {
      return json(200, {
        enabled: true,
        channels: [{ id: 1, username: 'revoked', title: 'Revoked', status: 'active', source, memberCount: 4730 }],
        selected: 1,
      });
    }
    if (path === '/api/prefs') return json(200, request.method() === 'GET' ? {} : { ok: true });
    if (path === '/api/history') {
      return json(200, {
        enabled: true,
        // Fresh history proves that reauth_required, not the two-day freshness heuristic, owns the alert.
        rows: [{ day: new Date().toISOString().slice(0, 10), subscribers: 4730, views: 1000, reactions: 50 }],
      });
    }
    if (path === '/api/tg/full') {
      return json(200, {
        channel: { title: 'Revoked', username: 'revoked', memberCount: 4730 },
        views_summary: { total_views: 1000, total_reactions: 50, posts_analyzed: 1, avg_views: 1000 },
        posts: [],
        source: source === 'central' ? 'managed' : 'db',
      });
    }
    if (path === '/api/tg/mtproto/graphs') return json(200, {});
    if (path === '/api/tg/qr/status') {
      return json(200, {
        server_ready: true,
        connected: true,
        username: 'revoked_user',
        connection_state: 'reauth_required',
        last_error_code: 'session_unauthorized',
        // The owner-only signal that turns the central channel's health actionable.
        central_owner: source === 'central',
      });
    }
    if (path === '/api/tg/qr/start') {
      qrStarts += 1;
      if (failFirstQrStart && qrStarts === 1) return json(503, { error: 'Сервис Telegram недоступен, попробуйте позже' });
      return json(200, { id: 'flow-1', url: 'tg://login?token=ZmFrZQ', expires_in: 60 });
    }
    if (path === '/api/tg/qr/poll') return json(200, { status: 'pending', url: 'tg://login?token=ZmFrZQ' });
    if (path === '/api/tg/qr/cancel') return json(200, { ok: true });

    // Optional cross-network inputs used by the Overview narrative.
    if (path === '/api/ig/profile') return json(200, { mock: true });
    if (path === '/api/ig/insights') return json(200, { mock: true, data: [] });
    if (path === '/api/ig/history') return json(200, { enabled: true, rows: [] });
    if (path === '/api/ig/posts') return json(200, { mock: true, data: [] });
    if (path === '/api/ig/oauth/status') return json(200, { connected: false, server_ready: true });

    return json(404, { error: 'not_mocked' });
  });

  await page.addInitScript(() => {
    localStorage.setItem('pulse_token', 'e2e-token');
    localStorage.setItem('pulse_token_exp', String(Date.now() + 60 * 60 * 1000));
    localStorage.setItem('pulse_theme', 'dark');
    localStorage.setItem('pulse_network', 'tg');
    localStorage.setItem('pulse_channel', '1');
  });
  await page.goto('/');
  await page.locator('main').waitFor({ state: 'visible' });
  return { qrStarts: () => qrStarts };
}

// The production case: the selected source is the managed CENTRAL channel, the caller owns it
// (central_owner=true), and its collecting session was revoked → the same actionable reconnect signal
// and focused Connect flow QR channels already get, with NO auto-start.
test('revoked central session (owner) opens the focused reconnect flow without auto-starting it', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop connection-health contract');
  const state = await bootRevokedSession(page, 'central', true);

  const reconnectLink = page.getByRole('link', { name: 'Переподключить Telegram →', exact: true });
  await expect(reconnectLink).toBeVisible();
  await expect(reconnectLink).toHaveAttribute('href', '/connect?source=telegram&tab=qr&action=reconnect');
  await expect(page.getByText('нужно переподключить', { exact: true })).toBeVisible();
  const overviewShot = testInfo.outputPath('telegram-central-reauth-banner-dark.png');
  await page.screenshot({ path: overviewShot, fullPage: true });
  await testInfo.attach('telegram-central-reauth-banner-dark', { path: overviewShot, contentType: 'image/png' });
  await reconnectLink.click();

  await expect(page).toHaveURL(/\/connect\?source=telegram&tab=qr&action=reconnect$/);
  await expect(page.getByText('Требуется вход', { exact: true })).toBeVisible();
  await expect(page.getByText('Сессия Telegram недействительна', { exact: true })).toBeVisible();
  await expect(page.getByText(/Каналы и вся история сохранены/)).toBeVisible();
  expect(state.qrStarts()).toBe(0);
  await expect(page.getByAltText('QR-код для входа в Telegram')).toHaveCount(0);

  const reconnectShot = testInfo.outputPath('telegram-central-reconnect-dark.png');
  await page.screenshot({ path: reconnectShot, fullPage: true });
  await testInfo.attach('telegram-central-reconnect-dark', { path: reconnectShot, contentType: 'image/png' });

  await page.getByRole('button', { name: 'Переподключить', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Telegram запускается…', exact: true })).toBeVisible();
  await expect.poll(state.qrStarts).toBe(2);
  await expect(page.getByAltText('QR-код для входа в Telegram')).toBeVisible();
});

// Retained QR-source branch: a managed QR channel keeps the exact same actionable reconnect signal.
test('revoked QR session shows the same actionable reconnect CTA', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop connection-health contract');
  const state = await bootRevokedSession(page, 'qr');

  const reconnectLink = page.getByRole('link', { name: 'Переподключить Telegram →', exact: true });
  await expect(reconnectLink).toBeVisible();
  await expect(reconnectLink).toHaveAttribute('href', '/connect?source=telegram&tab=qr&action=reconnect');
  await expect(page.getByText('нужно переподключить', { exact: true })).toBeVisible();
  expect(state.qrStarts()).toBe(0);
});
