import { expect, test, type Page } from '@playwright/test';

type ConnectSource = 'moysklad' | 'metrika' | 'telegram';

/**
 * Non-demo boot: demo mode intentionally rejects writes, while these tests need real controlled
 * error responses to prove aria-invalid/describedby/alert state after submission.
 */
async function bootDisconnectedConnect(page: Page, source: ConnectSource) {
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/api/auth/me') {
      return json(200, { uid: 42, email: 'owner@pulse.local', role: 'user', avatar: null });
    }
    if (path === '/api/channels' && request.method() === 'GET') {
      return json(200, {
        enabled: true,
        channels: [{
          id: 7,
          username: 'demo_channel',
          title: 'Demo Channel',
          status: 'active',
          source: 'collector',
          ig_connected: false,
        }],
      });
    }
    if (path === '/api/ms/status') return json(200, { connected: false, org_name: null });
    if (path === '/api/ym/status') {
      return json(200, { connected: false, counter_name: null, counter_id: null, site: null });
    }
    if (path === '/api/ig/oauth/status') {
      return json(200, { connected: false, server_ready: false, env_fallback: false });
    }
    if (path === '/api/tg/qr/status') {
      return json(200, { connected: false, server_ready: true, username: null });
    }
    if (path === '/api/ms/connect') return json(400, { error: 'Токен МойСклада отклонён' });
    if (path === '/api/ym/connect') return json(400, { error: 'OAuth-токен Яндекса отклонён' });
    if (path === '/api/tg/qr/start') {
      return json(200, { id: 'qr-a11y', url: 'tg://login?token=YWFh', expires_in: 60 });
    }
    if (path === '/api/tg/qr/poll') return json(200, { status: 'password' });
    if (path === '/api/tg/qr/password') return json(200, { status: 'error', error: 'bad_password' });
    return json(404, { error: 'not_stubbed' });
  });
  await page.addInitScript(() => {
    localStorage.setItem('pulse_channel', '7');
    localStorage.setItem('pulse_theme', 'dark');
  });
  await page.goto(`/connect?source=${source}${source === 'telegram' ? '&tab=qr' : ''}`);
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
}

for (const config of [
  {
    source: 'moysklad' as const,
    label: 'Токен API МойСклада',
    helpId: 'moysklad-api-token-help',
    errorId: 'moysklad-api-token-error',
    value: 'ms_test_token',
    error: 'Токен МойСклада отклонён',
  },
  {
    source: 'metrika' as const,
    label: 'OAuth-токен Яндекса',
    helpId: 'yandex-metrika-token-help',
    errorId: 'yandex-metrika-token-error',
    value: 'ym_test_token',
    error: 'OAuth-токен Яндекса отклонён',
  },
]) {
  test(`${config.label}: label, description and submitted error are programmatically associated`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Focused Connect semantics');
    await bootDisconnectedConnect(page, config.source);

    const input = page.getByLabel(config.label);
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('aria-describedby', config.helpId);
    await expect(input).not.toHaveAttribute('aria-invalid', 'true');

    await input.fill(config.value);
    await page.getByRole('button', { name: 'Подключить', exact: true }).click();

    const alert = page.getByRole('alert');
    await expect(alert).toHaveText(config.error);
    await expect(alert).toHaveAttribute('id', config.errorId);
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toHaveAttribute('aria-describedby', `${config.helpId} ${config.errorId}`);
  });
}

test('Telegram 2FA password has a label and announces a rejected password', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Focused Connect semantics');
  await bootDisconnectedConnect(page, 'telegram');

  await page.getByRole('button', { name: 'Показать QR-код' }).click();
  const password = page.getByLabel(/облачный пароль Telegram/i);
  await expect(password).toBeVisible({ timeout: 10_000 });
  await expect(password).not.toBeFocused();
  await expect(password).not.toHaveAttribute('aria-invalid', 'true');

  await password.fill('wrong-password');
  await page.getByRole('button', { name: 'Подтвердить' }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toHaveText('Неверный пароль');
  await expect(alert).toHaveAttribute('id', 'telegram-cloud-password-error');
  await expect(password).toHaveAttribute('aria-invalid', 'true');
  await expect(password).toHaveAttribute('aria-describedby', 'telegram-cloud-password-error');
});
