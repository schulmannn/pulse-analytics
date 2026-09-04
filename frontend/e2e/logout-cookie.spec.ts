import { expect, test, type Page } from '@playwright/test';

const ME = {
  uid: 7,
  email: 'user@example.com',
  role: 'user',
  avatar: null,
  ai: { enabled: false },
};

async function boot(page: Page, logoutStatus: number) {
  let logoutCalls = 0;
  await page.route(/^https?:\/\/[^/]+\/api\//, (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === '/api/config') return route.fulfill({ json: { google_client_id: null } });
    if (pathname === '/api/auth/me') return route.fulfill({ json: ME });
    if (pathname === '/api/channels') return route.fulfill({ json: { channels: [] } });
    if (pathname === '/api/auth/logout') {
      logoutCalls += 1;
      return route.fulfill({
        status: logoutStatus,
        json: logoutStatus === 200 ? { ok: true } : { error: 'Сервис временно недоступен' },
      });
    }
    return route.fulfill({ status: 404, json: { error: 'not_available_in_test' } });
  });
  await page.goto('/home');
  await expect(page.getByRole('button', { name: 'Аккаунт' })).toBeVisible();
  return () => logoutCalls;
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop cookie logout');
});

test('account menu navigates to login only after cookie logout succeeds', async ({ page }) => {
  const logoutCalls = await boot(page, 200);
  await page.getByRole('button', { name: 'Аккаунт' }).click();
  await page.getByRole('menuitem', { name: 'Выйти' }).click();

  await expect.poll(logoutCalls).toBe(1);
  await expect(page).toHaveURL(/\/login$/);
});

test('command palette keeps the protected page when cookie logout fails', async ({ page }) => {
  const logoutCalls = await boot(page, 503);
  await page.keyboard.press('Control+K');
  await page.getByRole('combobox', { name: 'Поиск' }).fill('Выйти');
  await page.getByRole('option', { name: 'Выйти' }).click();

  await expect.poll(logoutCalls).toBe(1);
  await expect(page).toHaveURL(/\/home$/);
});
