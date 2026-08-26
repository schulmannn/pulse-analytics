import { test, expect, type Page } from '@playwright/test';

// Focused desktop coverage for the redesigned /login card. Fully deterministic: every /api/* call is
// intercepted (no backend, no real Google script). config → google_client_id:null keeps the Google
// button inert, so nothing loads from accounts.google.com and the card renders offline.

type AuthRoutes = {
  login?: { status: number; body: unknown };
  forgot?: { status: number; body: unknown };
  me?: { status: number; body: unknown };
  migrate?: { status: number; body: unknown };
  onRequest?: (pathname: string, headers: Record<string, string>) => void;
};

async function mockAuth(page: Page, routes: AuthRoutes = {}): Promise<void> {
  await page.route(/^https?:\/\/[^/]+\/api\//, (r) => {
    const { pathname } = new URL(r.request().url());
    routes.onRequest?.(pathname, r.request().headers());
    if (pathname === '/api/auth/migrate-cookie') {
      const { status = 200, body = { ok: true } } = routes.migrate ?? {};
      return r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (pathname === '/api/config') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ google_client_id: null }) });
    }
    if (pathname === '/api/auth/me') {
      const { status = 200, body = { uid: 999, email: 'demo@pulse.local', role: 'user', avatar: null } } = routes.me ?? {};
      return r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (pathname === '/api/auth/login') {
      const { status = 200, body = { ok: true, user: { email: 'demo@pulse.local', role: 'user' } } } = routes.login ?? {};
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

test('logged-out root stays on the public Landing instead of redirecting to /login', async ({ page }) => {
  await mockAuth(page, {
    me: { status: 401, body: { error: 'Сессия истекла, войди снова' } },
  });
  await page.goto('/');

  // Маркер лендинга — его собственный h1. Раньше им был заголовок «Atlavue», но на минимальной
  // чёрной версии имя бренда живёт в топбаре-пилюле ссылкой, а не заголовком.
  await expect(page.getByRole('heading', { name: 'Вся аналитика в одном месте' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test('legacy token migrates before the first auth probe and is purged', async ({ page }) => {
  const calls: Array<{ pathname: string; token?: string }> = [];
  await mockAuth(page, {
    onRequest: (pathname, headers) => {
      calls.push({ pathname, token: headers['x-session-token'] });
    },
  });
  await page.addInitScript(() => {
    localStorage.setItem('pulse_token', 'legacy-e2e-token');
    localStorage.setItem('pulse_token_exp', String(Date.now() + 60_000));
  });
  await page.goto('/');

  await expect.poll(() => calls.some((call) => call.pathname === '/api/auth/me')).toBe(true);
  const migrateIndex = calls.findIndex((call) => call.pathname === '/api/auth/migrate-cookie');
  const meIndex = calls.findIndex((call) => call.pathname === '/api/auth/me');
  expect(migrateIndex).toBeGreaterThanOrEqual(0);
  expect(migrateIndex).toBeLessThan(meIndex);
  expect(calls[migrateIndex]?.token).toBe('legacy-e2e-token');
  await expect.poll(() => page.evaluate(() => ({
    token: localStorage.getItem('pulse_token'),
    exp: localStorage.getItem('pulse_token_exp'),
  }))).toEqual({ token: null, exp: null });
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
