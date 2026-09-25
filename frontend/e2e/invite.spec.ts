import { expect, test, type Page } from '@playwright/test';

/**
 * Приём приглашения в команду — `/invite?token=…`. Прод-фича без единого спека до этого файла
 * (аудит #554): её единственный тест жил на сервере, а страница проверялась только руками.
 *
 * Главное, что здесь пришпилено, — H-1. Сырая ссылка приглашения отдавалась ИНИЦИАТОРУ, и по ней
 * публичный /claim заводил сразу активный аккаунт на чужой email с паролем открывшего ссылку.
 * После #558 такая («раскрытая») ссылка не активирует аккаунт: пароль не спрашивается вовсе, а
 * человек уходит в «Проверьте почту». Нераскрытая ссылка сохраняет прежний быстрый путь.
 *
 * Boot БЕЗ pulse_demo: демо-фикстуры отдают ответы клиентски, до сети, и route-стабы под ними не
 * срабатывают — спек проходил бы вхолостую.
 */

type InviteState = {
  status?: 'live' | 'expired' | 'revoked' | 'accepted';
  needs_account?: boolean;
  verify_required?: boolean;
  claim?: { status: number; body: unknown };
};

async function bootInvite(page: Page, state: InviteState = {}) {
  const calls: Array<{ pathname: string; body: unknown }> = [];
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    calls.push({ pathname, body: request.method() === 'POST' ? request.postDataJSON() : null });
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    // Гость: сессии нет — именно в этом состоянии страница и предлагает завести аккаунт.
    if (pathname === '/api/auth/me') return json(401, { error: 'unauthorized' });
    if (pathname === '/api/config') return json(200, { google_client_id: null });
    if (pathname.startsWith('/api/team/invite/') && pathname.endsWith('/claim')) {
      const { status = 200, body = { ok: true, workspace: 'Команда', role: 'member' } } = state.claim ?? {};
      return json(status, body);
    }
    if (pathname.startsWith('/api/team/invite/')) {
      return json(200, {
        status: state.status ?? 'live',
        email: 'victim@example.com',
        role: 'member',
        workspace: 'Команда',
        invited_by: 'owner@example.com',
        needs_account: state.needs_account ?? true,
        verify_required: state.verify_required ?? false,
      });
    }
    return json(404, { error: 'not_stubbed' });
  });
  await page.addInitScript(() => localStorage.setItem('pulse_theme', 'dark'));
  await page.goto('/invite?token=raw-invite-token');
  return calls;
}

test.beforeEach(async ({ browserName: _b }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Приглашение — desktop-first поверхность');
});

test('H-1: по раскрытой ссылке пароль не спрашивается и аккаунт не активируется', async ({ page }) => {
  const calls = await bootInvite(page, {
    verify_required: true,
    claim: { status: 200, body: { ok: true, verify_required: true, workspace: 'Команда', role: 'member' } },
  });

  await expect(page.getByRole('heading', { name: 'Принять приглашение' })).toBeVisible({ timeout: 15_000 });
  // Поля пароля НЕТ: сервер его всё равно не сохранит, и спрашивать было бы враньём.
  await expect(page.getByLabel('Придумайте пароль')).toHaveCount(0);
  await expect(page.getByText(/ссылку мог видеть не только владелец адреса/i)).toBeVisible();

  await page.getByRole('button', { name: 'Отправить подтверждение' }).click();

  // Никуда не пускает: следующий шаг живёт в почте.
  await expect(page.getByRole('heading', { name: 'Проверьте почту' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('victim@example.com')).toBeVisible();
  await expect(page).toHaveURL(/\/invite/);

  const claim = calls.find((c) => c.pathname.endsWith('/claim'));
  expect(claim, 'claim должен уйти').toBeTruthy();
  expect((claim?.body as { password?: string } | null)?.password, 'пароль не отправляется').toBeUndefined();
});

test('нераскрытая ссылка сохраняет прежний путь: пароль и вход в приложение', async ({ page }) => {
  const calls = await bootInvite(page, { verify_required: false });

  await expect(page.getByLabel('Придумайте пароль')).toBeVisible({ timeout: 15_000 });
  await page.getByLabel('Придумайте пароль').fill('correct horse battery');
  await page.getByRole('button', { name: 'Принять и войти' }).click();

  // Уходим в приложение, а не в «Проверьте почту».
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
  const claim = calls.find((c) => c.pathname.endsWith('/claim'));
  expect((claim?.body as { password?: string } | null)?.password).toBe('correct horse battery');
});

test('мёртвая ссылка называет причину и не предлагает завести аккаунт', async ({ page }) => {
  for (const [status, reason] of [
    ['expired', /Срок действия ссылки истёк/],
    ['revoked', /Приглашение отозвано/],
    ['accepted', /уже принято/],
  ] as const) {
    await bootInvite(page, { status });
    await expect(page.getByRole('heading', { name: 'Приглашение недействительно' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(reason)).toBeVisible();
    await expect(page.getByLabel('Придумайте пароль')).toHaveCount(0);
  }
});

test('существующий аккаунт отправляется входить, а не заводить второй', async ({ page }) => {
  await bootInvite(page, { needs_account: false });
  await expect(page.getByText(/уже есть аккаунт Atlavue/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible();
  await expect(page.getByLabel('Придумайте пароль')).toHaveCount(0);
});

test('неполная ссылка не притворяется рабочей', async ({ page }) => {
  await page.route(/^https?:\/\/[^/]+\/api\//, (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' }));
  await page.goto('/invite');
  await expect(page.getByText(/Ссылка неполная/)).toBeVisible({ timeout: 15_000 });
});
