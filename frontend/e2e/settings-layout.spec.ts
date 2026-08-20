import { expect, test, type Page } from '@playwright/test';
import { bootDemo } from './helpers';

// /settings — модальный оверлей над приложением (роут остаётся ради deep-links). Master-detail
// внутри диалога: рейл при ширине КОНТЕЙНЕРА диалога ≥44rem, line-tabs уже. «Instagram» слит в
// «Каналы» (7 секций), легаси ?section=instagram переписывается на channels.
const SECTIONS = [
  { key: 'account', label: 'Профиль' },
  { key: 'appearance', label: 'Оформление' },
  { key: 'security', label: 'Безопасность' },
  { key: 'billing', label: 'Подписка' },
  { key: 'team', label: 'Команда' },
  { key: 'data', label: 'Данные' },
  { key: 'channels', label: 'Каналы' },
] as const;

async function expectNoShellOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-settings-scroll]');
    return {
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dialog: scroller ? scroller.scrollWidth - scroller.clientWidth : 0,
    };
  });
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.dialog).toBeLessThanOrEqual(1);
}

test('wide settings is a modal with a rail master-detail and one mounted section', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootDemo(page, '/settings');

  const dialog = page.getByRole('dialog', { name: 'Настройки' });
  await expect(dialog).toBeVisible();

  const rail = page.getByRole('navigation', { name: 'Разделы настроек' });
  await expect(rail).toBeVisible();
  await expect(rail.locator('[data-settings-nav-item]')).toHaveCount(7);
  await expect(page.getByRole('tablist', { name: 'Разделы настроек' })).toBeHidden();
  await expect(page.locator('[data-settings-section]')).toHaveCount(1);
  await expect(page.locator('[data-settings-section="account"]')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Профиль', level: 2 })).toBeVisible();
  await expect(rail.getByRole('button', { name: 'Профиль', exact: true })).toHaveAttribute(
    'aria-current',
    'true',
  );

  // Единственный видимый h1 — у фоновой страницы за модалкой; сам диалог h1 не добавляет.
  const visibleH1 = await page.locator('h1').evaluateAll((headings) =>
    headings.filter((heading) => {
      const element = heading as HTMLElement;
      return Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    }).length,
  );
  expect(visibleH1).toBeLessThanOrEqual(1);
  await expectNoShellOverflow(page);

  await rail.locator('[data-settings-nav-item="billing"]').click();
  await expect(page.locator('[data-settings-plan-card]')).toHaveCount(3);
});

test('escape closes the settings modal back out of /settings', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one project owns the close contract');

  await page.setViewportSize({ width: 1440, height: 900 });
  await bootDemo(page, '/home');
  await page.goto('/settings?section=billing');
  await expect(page.getByRole('dialog', { name: 'Настройки' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Настройки' })).toBeHidden();
  await expect(page).toHaveURL(/\/home$/);
});

test('narrow settings containers use seven 44px line tabs without shell overflow', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one worker owns the viewport matrix');

  await page.setViewportSize({ width: 900, height: 900 });
  await bootDemo(page, '/settings');

  // Широкое окно: контейнер диалога ≥44rem — рейл даже на 900/768 (диалог шире страницы-колонки).
  for (const viewport of [
    { width: 900, height: 900 },
    { width: 768, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/settings');
    await expect(page.getByRole('navigation', { name: 'Разделы настроек' })).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Разделы настроек' })).toBeHidden();
    await expectNoShellOverflow(page);
  }

  // Узкое окно (диалог <44rem) и телефон (full-screen sheet): line-tabs с 44px-таргетами.
  for (const viewport of [
    { width: 700, height: 900 },
    { width: 360, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/settings');

    await expect(page.getByRole('navigation', { name: 'Разделы настроек' })).toBeHidden();
    const tablist = page.getByRole('tablist', { name: 'Разделы настроек' });
    await expect(tablist).toBeVisible();
    const tabs = tablist.getByRole('tab');
    await expect(tabs).toHaveCount(7);
    // Poll: входной zoom-in-95 диалога на долю секунды масштабирует rect'ы (44 × 0.95 ≈ 41.8).
    await expect
      .poll(async () => {
        const heights = await tabs.evaluateAll((elements) =>
          elements.map((element) => element.getBoundingClientRect().height),
        );
        return heights.length === 7 && heights.every((height) => height >= 44);
      })
      .toBe(true);
    await expectNoShellOverflow(page);
  }
});

test('all section deep links mount only their detail and preserve unrelated query params', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one project owns the URL matrix');

  await page.setViewportSize({ width: 1440, height: 900 });
  await bootDemo(page, '/settings?section=account&keep=1');

  for (const item of SECTIONS) {
    await page.goto(`/settings?section=${item.key}&keep=1`);
    const heading = page.locator(`#settings-${item.key}-title`);
    await expect(heading).toBeVisible();
    await expect(heading).toHaveText(item.label);
    await expect(page.locator('[data-settings-section]')).toHaveCount(1);
    await expect(page.locator('[data-settings-section]')).toHaveAttribute(
      'data-settings-section',
      item.key,
    );
    for (const sibling of SECTIONS.filter((candidate) => candidate.key !== item.key)) {
      await expect(page.locator(`#settings-${sibling.key}-title`)).toHaveCount(0);
    }
    await expect(
      page
        .getByRole('navigation', { name: 'Разделы настроек' })
        .locator(`[data-settings-nav-item="${item.key}"]`),
    ).toHaveAttribute('aria-current', 'true');
    expect(new URL(page.url()).searchParams.get('section')).toBe(item.key);
    expect(new URL(page.url()).searchParams.get('keep')).toBe('1');
  }

  // Легаси-ключ: Instagram слит в «Каналы» — старые ссылки приземляются туда, а не на дефолт.
  await page.goto('/settings?section=instagram&keep=1');
  await expect(page.getByRole('heading', { name: 'Каналы', level: 2 })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('section')).toBe('channels');
  expect(new URL(page.url()).searchParams.get('keep')).toBe('1');

  await page.goto('/settings?section=unknown&keep=1');
  await expect(page.getByRole('heading', { name: 'Профиль', level: 2 })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('section')).toBeNull();
  expect(new URL(page.url()).searchParams.get('keep')).toBe('1');
});

test('keyboard section activation focuses its heading and replaces settings history', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one project owns the history contract');

  await page.setViewportSize({ width: 1440, height: 900 });
  await bootDemo(page, '/home');
  await page.goto('/settings');
  const billing = page.locator('[data-settings-nav-item="billing"]');
  await billing.focus();
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/[?&]section=billing(?:&|$)/);
  await expect(page.locator('#settings-billing-title')).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(/\/home$/);
});

test('billing cards stay stacked with exactly one recommended solid CTA', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one worker owns the viewport matrix');

  await page.setViewportSize({ width: 1440, height: 900 });
  await bootDemo(page, '/settings?section=billing');

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 900, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/settings?section=billing');
    const cards = page.locator('[data-settings-plan-card]');
    await expect(cards).toHaveCount(3);
    const boxes = await cards.evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { width: box.width, top: Math.round(box.top) };
      }),
    );
    expect(boxes.every((box) => box.width >= 300)).toBe(true);
    expect(new Set(boxes.map((box) => box.top)).size).toBe(3);
    const solidCtas = await cards.getByRole('button').evaluateAll(
      (buttons) => buttons.filter((button) => button.classList.contains('bg-primary')).length,
    );
    expect(solidCtas).toBe(1);
    await expectNoShellOverflow(page);
  }
});

test('channel API key flow keeps 44px phone targets', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one worker owns the route-mocked phone flow');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === '/api/config') {
      return route.fulfill({ json: { google_client_id: null } });
    }
    if (pathname === '/api/auth/me') {
      return route.fulfill({
        json: { uid: 7, email: 'user@example.com', role: 'user', avatar: null },
      });
    }
    if (pathname === '/api/channels' && request.method() === 'GET') {
      return route.fulfill({
        json: {
          enabled: true,
          selected: 1,
          channels: [
            {
              id: 1,
              username: 'collector_one',
              title: 'Тестовый канал',
              status: 'active',
              source: 'collector',
            },
          ],
        },
      });
    }
    if (/^\/api\/channels\/\d+\/collector-status$/.test(pathname)) {
      return route.fulfill({ json: { status: null } });
    }
    if (/^\/api\/channels\/\d+\/keys$/.test(pathname)) {
      return route.fulfill({
        json: { keys: [{ id: 11, key_prefix: 'demo', label: 'collector', revoked: false }] },
      });
    }
    if (/^\/api\/channels\/\d+\/key$/.test(pathname) && request.method() === 'POST') {
      return route.fulfill({
        json: {
          id: 12,
          key_prefix: 'fresh',
          label: 'settings-ui',
          key: 'fresh_test_token',
          revoked: false,
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: 'not_available_in_test' } });
  });

  await page.goto('/settings?section=channels');
  await expect(page.getByRole('dialog', { name: 'Настройки' })).toBeVisible();
  await page.getByRole('button', { name: 'API-ключи' }).click();
  const keyPanel = page.locator('[data-settings-key-panel]');
  await keyPanel.getByRole('button', { name: 'Создать ключ' }).click();
  const copy = keyPanel.getByRole('button', { name: 'Копировать' });
  await expect(copy).toBeVisible();
  await copy.click();
  await expect(keyPanel.getByRole('button', { name: 'Скопировано' })).toBeVisible();

  const heights = await keyPanel.locator('[data-mobile-touch-target]').evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().height),
  );
  expect(heights.length).toBeGreaterThanOrEqual(4);
  expect(heights.every((height) => height >= 44)).toBe(true);
  await expectNoShellOverflow(page);
});

test('password form opens in a resettable dialog above the settings modal', async ({ page }) => {
  await bootDemo(page, '/settings?section=security');

  await expect(page.getByLabel('Текущий пароль')).toHaveCount(0);
  await page.getByRole('button', { name: 'Сменить пароль' }).click();
  const dialog = page.getByRole('dialog', { name: 'Сменить пароль' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Новый пароль', { exact: true }).fill('short');
  await expect(dialog.getByLabel('Новый пароль', { exact: true })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(dialog.getByText('Минимум 8 символов.')).toBeVisible();
  await dialog.getByLabel('Повторите новый пароль').fill('different');
  await expect(dialog.getByLabel('Повторите новый пароль')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(dialog.getByText('Пароли не совпадают.')).toBeVisible();
  // Escape гасит только верхний диалог: настройки под ним остаются открытыми.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Настройки' })).toBeVisible();

  await page.getByRole('button', { name: 'Сменить пароль' }).click();
  await expect(
    page
      .getByRole('dialog', { name: 'Сменить пароль' })
      .getByLabel('Новый пароль', { exact: true }),
  ).toHaveValue('');
});
