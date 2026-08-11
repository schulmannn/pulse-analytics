import { test, expect, type Page } from '@playwright/test';

// Настройки → аккаунт: здесь живёт GDPR-удаление аккаунта (typeToConfirm по email), и до сих пор
// у него не было e2e-сетки. Полностью детерминированно: каждый /api/* перехвачен. Demo-режим
// НАМЕРЕННО не используется — он блокирует записи, а нам нужен настоящий DELETE /api/account.

const ME = { uid: 7, email: 'user@example.com', role: 'user', avatar: null };

type DeleteStub = { status?: number; contentType?: string; body?: string };

async function bootSettings(page: Page, deleteStub: DeleteStub = {}) {
  const deletes: Array<unknown> = [];
  await page.route(/^https?:\/\/[^/]+\/api\//, (r) => {
    const request = r.request();
    const { pathname } = new URL(request.url());
    if (pathname === '/api/config') {
      return r.fulfill({ json: { google_client_id: null } });
    }
    if (pathname === '/api/auth/me') {
      return r.fulfill({ json: ME });
    }
    if (pathname === '/api/account' && request.method() === 'DELETE') {
      deletes.push(request.postDataJSON());
      return r.fulfill({
        status: deleteStub.status ?? 200,
        contentType: deleteStub.contentType ?? 'application/json',
        body: deleteStub.body ?? JSON.stringify({ ok: true }),
      });
    }
    return r.fulfill({ status: 404, json: { error: 'not_available_in_test' } });
  });
  await page.addInitScript(() => {
  });
  await page.goto('/settings?section=security');
  await expect(page.getByRole('heading', { name: 'Безопасность', level: 3 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Удалить аккаунт' })).toBeVisible();
  return deletes;
}

test.beforeEach(({ page: _page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop settings surface');
});

test('удаление аккаунта заблокировано, пока email не совпал (регистр не важен)', async ({ page }) => {
  const deletes = await bootSettings(page);
  await page.getByRole('button', { name: 'Удалить аккаунт' }).click();

  await expect(page.getByRole('heading', { name: 'Удалить аккаунт навсегда?' })).toBeVisible();
  const submit = page.getByRole('button', { name: 'Удалить навсегда' });
  await expect(submit).toBeDisabled();

  await page.getByLabel('Email аккаунта').fill('wrong@example.com');
  await expect(submit).toBeDisabled();

  // Совпадение case-insensitive — точный контракт DeleteAccountRow.
  await page.getByLabel('Email аккаунта').fill('USER@example.com');
  await expect(submit).toBeEnabled();

  await page.getByRole('button', { name: 'Отмена' }).click();
  await expect(page.getByRole('heading', { name: 'Удалить аккаунт навсегда?' })).toBeHidden();
  expect(deletes).toHaveLength(0);
});

test('подтверждённое удаление шлёт DELETE c confirm и уводит на лендинг', async ({ page }) => {
  const deletes = await bootSettings(page);
  await page.getByRole('button', { name: 'Удалить аккаунт' }).click();
  await page.getByLabel('Email аккаунта').fill('user@example.com');
  await page.getByRole('button', { name: 'Удалить навсегда' }).click();

  // Успех = window.location.assign('/'): полная перезагрузка прочь из настроек. Куда именно
  // приземлится свежая загрузка, зависит от auth-гейта, а addInitScript пере-сеет токен —
  // поэтому пиним сам факт редиректа и точное тело DELETE, а очистку сессии держит unit-слой.
  await page.waitForURL((url) => url.pathname !== '/settings');
  expect(deletes).toEqual([{ confirm: 'user@example.com' }]);
});

test('ошибка сервера остаётся в подтверждении и не уводит со страницы', async ({ page }) => {
  await bootSettings(page, {
    status: 400,
    body: JSON.stringify({ error: 'Подтверждение не совпадает с email аккаунта' }),
  });
  await page.getByRole('button', { name: 'Удалить аккаунт' }).click();
  await page.getByLabel('Email аккаунта').fill('user@example.com');
  await page.getByRole('button', { name: 'Удалить навсегда' }).click();

  await expect(page.getByText('Подтверждение не совпадает с email аккаунта')).toBeVisible();
  await expect(page).toHaveURL(/\/settings/);
});

test('non-JSON 502 показывается человеческим текстом, а не «502 Bad Gateway»', async ({ page }) => {
  await bootSettings(page, {
    status: 502,
    contentType: 'text/html',
    body: '<html>bad gateway</html>',
  });
  await page.getByRole('button', { name: 'Удалить аккаунт' }).click();
  await page.getByLabel('Email аккаунта').fill('user@example.com');
  await page.getByRole('button', { name: 'Удалить навсегда' }).click();

  await expect(page.getByText('Сервер временно недоступен — попробуйте позже')).toBeVisible();
  await expect(page.getByText('Bad Gateway')).toBeHidden();
  await expect(page).toHaveURL(/\/settings/);
});
