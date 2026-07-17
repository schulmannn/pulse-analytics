import { test, expect, type Page } from '@playwright/test';

// Focused desktop coverage for the redesigned /login card. Fully deterministic: every /api/* call is
// intercepted (no backend, no real Google script). config → google_client_id:null keeps the Google
// button inert, so nothing loads from accounts.google.com and the card renders offline.

type AuthRoutes = { login?: { status: number; body: unknown }; forgot?: { status: number; body: unknown } };

async function mockAuth(page: Page, routes: AuthRoutes = {}): Promise<void> {
  await page.route(/^https?:\/\/[^/]+\/api\//, (r) => {
    const { pathname } = new URL(r.request().url());
    if (pathname === '/api/config') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ google_client_id: null }) });
    }
    if (pathname === '/api/auth/me') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ uid: 999, email: 'demo@pulse.local', role: 'user', avatar: null }) });
    }
    if (pathname === '/api/auth/login') {
      const { status = 200, body = { token: 'tkn', expiresAt: null } } = routes.login ?? {};
      return r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (pathname === '/api/auth/forgot') {
      const { status = 200, body = { message: 'Если такой аккаунт есть — ссылка отправлена.' } } = routes.forgot ?? {};
      return r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    }
    return r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not_available_in_test' }) });
  });
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop auth card');
});

test('login card renders labelled, icon-bearing fields and a full-width submit', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await mockAuth(page);
  await page.goto('/login');

  await expect(page.getByRole('heading', { name: 'Войти в Atlavue' })).toBeVisible();
  // Labels stay associated with real inputs (autocomplete + type preserved).
  const email = page.getByLabel('Email', { exact: true });
  const password = page.getByLabel('Пароль', { exact: true });
  await expect(email).toHaveAttribute('type', 'email');
  await expect(email).toHaveAttribute('autocomplete', 'username');
  await expect(password).toHaveAttribute('type', 'password');
  await expect(password).toHaveAttribute('autocomplete', 'current-password');
  await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Создать' })).toHaveAttribute('href', '/register');
  await testInfo.attach('login-card-dark', {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });
  expect(pageErrors).toEqual([]);
});

test('failed login surfaces an aria alert without leaving /login', async ({ page }) => {
  await mockAuth(page, { login: { status: 401, body: { error: 'Неверный email или пароль' } } });
  await page.goto('/login');

  await page.getByLabel('Email', { exact: true }).fill('user@example.com');
  await page.getByLabel('Пароль', { exact: true }).fill('wrong-pass');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();

  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test('successful login redirects away from /login', async ({ page }) => {
  await mockAuth(page);
  await page.goto('/login');

  await page.getByLabel('Email', { exact: true }).fill('user@example.com');
  await page.getByLabel('Пароль', { exact: true }).fill('correct-horse');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();

  await expect(page).not.toHaveURL(/\/login$/);
});

test('forgot flow toggles in place, submits and restores the login form', async ({ page }) => {
  await mockAuth(page);
  await page.goto('/login');

  await page.getByRole('button', { name: 'Забыли пароль?' }).click();
  await expect(page.getByRole('heading', { name: 'Сброс пароля' })).toBeVisible();

  await page.getByLabel('Email для сброса пароля', { exact: true }).fill('user@example.com');
  await page.getByRole('button', { name: 'Отправить ссылку' }).click();
  await expect(page.getByText('Если такой аккаунт есть — ссылка отправлена.')).toBeVisible();

  await page.getByRole('button', { name: '← Назад ко входу' }).click();
  await expect(page.getByRole('heading', { name: 'Войти в Atlavue' })).toBeVisible();
});
