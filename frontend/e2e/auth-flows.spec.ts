import { test, expect, type Page } from '@playwright/test';

// Register / verify / reset — auth-потоки, у которых не было e2e-сетки (login покрыт
// auth-login.spec). Детерминированно по канону auth-login: каждый /api/* перехвачен,
// google_client_id:null держит Google-кнопку инертной.

type Captured = { path: string; body: unknown };

async function mockAuthApi(page: Page, overrides: Record<string, { status: number; body: unknown }> = {}) {
  const posts: Captured[] = [];
  await page.route(/^https?:\/\/[^/]+\/api\//, (r) => {
    const request = r.request();
    const { pathname } = new URL(request.url());
    if (pathname === '/api/config') {
      return r.fulfill({ json: { google_client_id: null } });
    }
    if (request.method() === 'POST' && pathname.startsWith('/api/auth/')) {
      posts.push({ path: pathname, body: request.postDataJSON() });
      // message опускаем: в AuthMessageSchema он optional (не nullable) — null уронил бы парсинг.
      const stub = overrides[pathname] ?? { status: 200, body: { ok: true } };
      return r.fulfill({ status: stub.status, json: stub.body });
    }
    return r.fulfill({ status: 404, json: { error: 'not_available_in_test' } });
  });
  return posts;
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop auth card');
});

test('регистрация шлёт точное тело и показывает «проверьте почту»', async ({ page }) => {
  const posts = await mockAuthApi(page, {
    '/api/auth/register': { status: 200, body: { ok: true, message: 'Проверьте почту для подтверждения аккаунта.' } },
  });
  await page.goto('/register');

  await page.getByLabel('Email', { exact: true }).fill('new-user@example.com');
  await page.getByLabel('Пароль', { exact: true }).fill('correct-horse-8');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();

  await expect(page.getByText('Проверьте почту для подтверждения аккаунта.')).toBeVisible();
  expect(posts).toEqual([
    { path: '/api/auth/register', body: { email: 'new-user@example.com', password: 'correct-horse-8' } },
  ]);
});

test('ошибка регистрации выводится aria-alert и не покидает /register', async ({ page }) => {
  await mockAuthApi(page, {
    '/api/auth/register': { status: 409, body: { error: 'Такой email уже зарегистрирован' } },
  });
  await page.goto('/register');

  await page.getByLabel('Email', { exact: true }).fill('taken@example.com');
  await page.getByLabel('Пароль', { exact: true }).fill('correct-horse-8');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();

  await expect(page.getByRole('alert')).toHaveText('Такой email уже зарегистрирован');
  await expect(page).toHaveURL(/\/register$/);
});

test('verify без токена честно объясняет неполную ссылку и не показывает кнопку', async ({ page }) => {
  const posts = await mockAuthApi(page);
  await page.goto('/verify');

  await expect(page.getByText(/Ссылка неполная/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Подтвердить email' })).toHaveCount(0);
  expect(posts).toHaveLength(0);
});

test('verify с токеном подтверждает email одним точным POST', async ({ page }) => {
  const posts = await mockAuthApi(page);
  await page.goto('/verify?token=tok-123');

  await page.getByRole('button', { name: 'Подтвердить email' }).click();
  await expect(page.getByText('Email подтверждён.')).toBeVisible();
  expect(posts).toEqual([{ path: '/api/auth/verify', body: { token: 'tok-123' } }]);
});

test('reset без токена честно блокирует форму', async ({ page }) => {
  const posts = await mockAuthApi(page);
  await page.goto('/reset');

  await expect(page.getByText(/Ссылка неполная/)).toBeVisible();
  await expect(page.getByLabel('Новый пароль', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Сохранить пароль' })).toBeDisabled();
  expect(posts).toHaveLength(0);
});

test('reset с токеном сохраняет пароль одним точным POST и уводит на /login', async ({ page }) => {
  const posts = await mockAuthApi(page);
  await page.goto('/reset?token=tok-456');

  await page.getByLabel('Новый пароль', { exact: true }).fill('brand-new-pass-9');
  await page.getByRole('button', { name: 'Сохранить пароль' }).click();

  await expect(page).toHaveURL(/\/login$/);
  expect(posts).toEqual([{ path: '/api/auth/reset', body: { token: 'tok-456', password: 'brand-new-pass-9' } }]);
});
