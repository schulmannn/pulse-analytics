import { test, expect, type Page } from '@playwright/test';
import { selectPill } from './helpers';

// Админка пользователей: роли/статусы и admin-путь GDPR-удаления не имели e2e-сетки. Полностью
// детерминированно (все /api/* перехвачены); сервер играет суперюзера uid=1.

const USERS_PAYLOAD = {
  users: [
    { id: 1, email: 'admin@pulse.local', role: 'superuser', status: 'active', created_at: '2026-01-10T10:00:00' },
    { id: 2, email: 'member@pulse.local', role: 'user', status: 'active', created_at: '2026-02-11T10:00:00' },
  ],
  roles: ['user', 'superuser'],
  statuses: ['unverified', 'pending', 'active', 'disabled'],
  me: 1,
};

async function bootAdmin(page: Page) {
  const patches: Array<{ id: string; body: unknown }> = [];
  const userDeletes: string[] = [];
  await page.route(/^https?:\/\/[^/]+\/api\//, (r) => {
    const request = r.request();
    const { pathname } = new URL(request.url());
    if (pathname === '/api/config') return r.fulfill({ json: { google_client_id: null } });
    if (pathname === '/api/auth/me') {
      return r.fulfill({ json: { uid: 1, email: 'admin@pulse.local', role: 'superuser', avatar: null } });
    }
    const patchMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
    if (patchMatch && request.method() === 'PATCH') {
      const body = request.postDataJSON() as Record<string, unknown>;
      patches.push({ id: patchMatch[1], body });
      const source = USERS_PAYLOAD.users.find((u) => String(u.id) === patchMatch[1]);
      return r.fulfill({ json: { ...source, ...body } });
    }
    if (patchMatch && request.method() === 'DELETE') {
      userDeletes.push(patchMatch[1]);
      return r.fulfill({ json: { ok: true } });
    }
    if (pathname === '/api/admin/users') return r.fulfill({ json: USERS_PAYLOAD });
    return r.fulfill({ status: 404, json: { error: 'not_available_in_test' } });
  });
  await page.addInitScript(() => {
  });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Управление пользователями' })).toBeVisible();
  return { patches, userDeletes };
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop admin surface');
});

test('собственная строка админа заблокирована от self-lockout, суперюзер не удаляем', async ({ page }) => {
  await bootAdmin(page);

  await expect(page.getByText('(вы)')).toBeVisible();
  await expect(page.getByLabel('Роль admin@pulse.local')).toBeDisabled();
  await expect(page.getByLabel('Статус admin@pulse.local')).toBeDisabled();
  // Кнопки удаления нет ни у себя, ни у суперюзера (сервер продублирует запрет).
  await expect(page.getByLabel('Удалить аккаунт admin@pulse.local')).toHaveCount(0);

  // Чужая обычная строка полностью управляема.
  await expect(page.getByLabel('Роль member@pulse.local')).toBeEnabled();
  await expect(page.getByLabel('Удалить аккаунт member@pulse.local')).toBeVisible();
});

test('смена роли пользователя шлёт точечный PATCH', async ({ page }) => {
  const { patches } = await bootAdmin(page);

  await selectPill(page.getByLabel('Роль member@pulse.local'), { value: 'superuser' });
  await expect.poll(() => patches).toEqual([{ id: '2', body: { role: 'superuser' } }]);
});

test('удаление пользователя двухшаговое: взвод, затем DELETE', async ({ page }) => {
  const { userDeletes } = await bootAdmin(page);

  const arm = page.getByLabel('Удалить аккаунт member@pulse.local');
  await arm.click();
  // Первый клик только взводит — запроса ещё нет, кнопка меняет смысл.
  const confirm = page.getByLabel('Подтвердить удаление аккаунта member@pulse.local');
  await expect(confirm).toBeVisible();
  expect(userDeletes).toHaveLength(0);

  await confirm.click();
  await expect.poll(() => userDeletes).toEqual(['2']);
});
