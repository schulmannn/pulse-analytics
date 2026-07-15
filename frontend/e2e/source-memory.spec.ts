import { expect, test, type Page } from '@playwright/test';

const channels = [
  {
    id: 1,
    username: 'telegram_only',
    title: 'Telegram only',
    status: 'active',
    source: 'collector',
    ig_connected: false,
  },
  {
    id: 2,
    username: 'shared_source',
    title: 'Shared source',
    status: 'active',
    source: 'collector',
    ig_connected: true,
  },
];

async function bootSourceMemory(page: Page) {
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body =
      path === '/api/auth/me'
        ? { uid: 11, email: 'source@test.local', role: 'user', avatar: null }
        : path === '/api/channels'
          ? { enabled: true, channels, selected: 1 }
          : path === '/api/prefs'
            ? {}
            : { error: 'not_mocked' };
    await route.fulfill({
      status: path === '/api/auth/me' || path === '/api/channels' || path === '/api/prefs' ? 200 : 404,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  await page.addInitScript(() => {
    if (localStorage.getItem('source_memory_seeded')) return;
    localStorage.setItem('source_memory_seeded', '1');
    localStorage.setItem('pulse_token', 'e2e-token');
    localStorage.setItem('pulse_token_exp', String(Date.now() + 60 * 60 * 1000));
    localStorage.setItem('pulse_theme', 'dark');
    localStorage.setItem('pulse_network', 'tg');
    localStorage.setItem('pulse_channel', '1');
    localStorage.setItem('pulse_source_channels', JSON.stringify({ tg: 1, ig: 2 }));
  });
}

async function expectSource(page: Page, handle: string) {
  await expect(page.getByRole('button', { name: new RegExp(`@${handle}`) }).first()).toBeVisible();
}

test('desktop restores the remembered channel for each network before the first request', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop source-switcher contract');
  await bootSourceMemory(page);

  await page.goto('/');
  await expectSource(page, 'telegram_only');

  // A direct route load must use the destination network's memory, even though pulse_network still
  // contains the previous network when the new document starts.
  await page.goto('/instagram');
  await expectSource(page, 'shared_source');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('pulse_channel'))).toBe('2');

  await page.goto('/');
  await expectSource(page, 'telegram_only');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('pulse_channel'))).toBe('1');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('pulse_source_channels'))).toBe(
    JSON.stringify({ tg: 1, ig: 2 }),
  );

  // Shared surfaces keep the last explicit network/source instead of snapping to Telegram.
  await page.getByRole('link', { name: 'Главная' }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expectSource(page, 'telegram_only');
});

test('shared routes keep Instagram after a direct Instagram load', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop source-switcher contract');
  await bootSourceMemory(page);

  // This is deliberately document navigation, not a client-side link. The production regression
  // only appeared after a reload: /instagram selected IG in memory, but left pulse_network='tg'.
  await page.goto('/instagram');
  await expectSource(page, 'shared_source');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('pulse_network'))).toBe('ig');

  await page.goto('/home');
  await expectSource(page, 'shared_source');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('pulse_network'))).toBe('ig');

  await page.goto('/reports');
  await expectSource(page, 'shared_source');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('pulse_network'))).toBe('ig');
});
